import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import { setupServer } from 'msw/node';
import { delay, http, HttpResponse } from 'msw';
import type {
  BalancesResponseWire,
  LedgerAccount,
  TransactionPageWire,
} from '@pfm/contracts';
import { TransactionsPage } from '../transactions/TransactionsPage.jsx';
import { endOfLastMonth, formatAsOf, localIsoDate } from './asOf.js';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const CHECKING = '11111111-1111-4111-8111-111111111111';
const SAVINGS = '22222222-2222-4222-8222-222222222222';
const VISA = '33333333-3333-4333-8333-333333333333';
const CLOSED = '44444444-4444-4444-8444-444444444444';

const account = (
  id: string,
  name: string,
  kind: LedgerAccount['kind'],
): LedgerAccount => ({
  id,
  name,
  kind,
  currency: 'USD',
  isSystem: false,
  archivedAt: null,
  createdAt: '2026-04-01T09:00:00.000Z',
});

const accounts = [
  account(CHECKING, 'Everyday Checking', 'asset'),
  account(SAVINGS, 'High-Yield Savings', 'asset'),
  account(VISA, 'Visa Credit Card', 'liability'),
];

/**
 * `CLOSED` is archived: it is absent from the account list but present in the
 * response and counted in `subtotals.asset` and `netWorthMinor`. That makes
 * both totals differ from anything derivable from the visible rows, so a
 * client-side sum cannot pass these assertions.
 */
const balances: BalancesResponseWire = {
  asOf: '2026-09-21',
  accounts: [
    { ledgerAccountId: CHECKING, kind: 'asset', archived: false, balanceMinor: '485000' },
    { ledgerAccountId: SAVINGS, kind: 'asset', archived: false, balanceMinor: '1230000' },
    { ledgerAccountId: CLOSED, kind: 'asset', archived: true, balanceMinor: '12345' },
    { ledgerAccountId: VISA, kind: 'liability', archived: false, balanceMinor: '80000' },
  ],
  subtotals: { asset: '1727345', liability: '80000' },
  netWorthMinor: '1647345',
};

const emptyPage: TransactionPageWire = { data: [], nextCursor: null };

const Url = () => <span data-testid="url">{useLocation().search}</span>;

type Options = {
  url?: string;
  balances?: () => Promise<Response> | Response;
};

const renderApp = ({ url = `/transactions?account=${CHECKING}`, ...options }: Options = {}) => {
  const asked: (string | null)[] = [];

  server.use(
    http.get('*/api/v1/accounts/balances', async ({ request }) => {
      asked.push(new URL(request.url).searchParams.get('asOf'));
      return options.balances ? await options.balances() : HttpResponse.json(balances);
    }),
    http.get('*/api/v1/accounts', () => HttpResponse.json(accounts)),
    http.get('*/api/v1/entries', () => HttpResponse.json(emptyPage)),
  );

  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[url]}>
        <TransactionsPage />
        <Url />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { asked, url: () => screen.getByTestId('url').textContent ?? '' };
};

const sidebar = () => screen.getByRole('navigation', { name: 'Accounts' });

const problem = (status: number, detail: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: 'Service unavailable', status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

describe('balances as of today', () => {
  it('renders every level from the response and sums nothing', async () => {
    renderApp();

    const nav = sidebar();
    expect(await within(nav).findByText('4,850.00')).toBeInTheDocument();
    expect(within(nav).getByText('12,300.00')).toBeInTheDocument();

    expect(within(nav).getByText('17,273.45')).toBeInTheDocument();
    expect(within(nav).getByText('16,473.45')).toBeInTheDocument();

    // What a browser-side sum over the visible rows would have produced.
    expect(within(nav).queryByText('17,150.00')).not.toBeInTheDocument();
    expect(within(nav).queryByText('16,350.00')).not.toBeInTheDocument();
  });

  it('keeps archived accounts out of the list while their money stays in the totals', async () => {
    renderApp();

    await within(sidebar()).findByText('4,850.00');
    expect(within(sidebar()).queryByText('123.45')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Checking|Savings|Visa/ })).toHaveLength(3);
  });

  it('labels a liability as owed and never flips its sign', async () => {
    renderApp({ url: `/transactions?account=${VISA}` });

    const nav = sidebar();
    const card = await within(nav).findByRole('button', { name: /Visa Credit Card/ });

    expect(within(card).getByText('800.00')).toBeInTheDocument();
    expect(within(card).getByText('owed')).toBeInTheDocument();
    expect(screen.getByText('Balance owed')).toBeInTheDocument();
    expect(card.textContent).not.toContain('-');
  });

  it('shows an overdrawn asset with a minus sign, not an error colour', async () => {
    renderApp({
      balances: () =>
        HttpResponse.json({
          ...balances,
          accounts: [
            { ledgerAccountId: CHECKING, kind: 'asset', archived: false, balanceMinor: '-12000' },
          ],
          subtotals: { asset: '-12000', liability: '0' },
          netWorthMinor: '-12000',
        } satisfies BalancesResponseWire),
    });

    const figures = await screen.findAllByText('-120.00');

    expect(figures.length).toBeGreaterThan(0);
    for (const figure of figures) expect(figure.className).not.toMatch(/rose|red/);
  });

  it('asks for the user’s local date even with no asOf in the URL', async () => {
    const app = renderApp();

    await within(sidebar()).findByText('4,850.00');
    expect(app.asked).toEqual([localIsoDate(new Date())]);
    expect(app.url()).not.toContain('asOf');
  });

  it('takes the header figure from the same response when the account changes', async () => {
    const app = renderApp();

    const nav = sidebar();
    fireEvent.click(await within(nav).findByRole('button', { name: /High-Yield Savings/ }));

    expect(await screen.findByRole('heading', { name: 'High-Yield Savings' })).toBeInTheDocument();
    expect(app.asked).toHaveLength(1);
  });
});

describe('choosing a date', () => {
  const open = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /^Balances as of/ }));
    return screen.findByRole('dialog', { name: 'Choose a date' });
  };

  it('writes asOf to the URL and refetches on that date', async () => {
    const app = renderApp();
    const last = endOfLastMonth(new Date());

    const popover = await open();
    fireEvent.click(within(popover).getByRole('button', { name: 'End of last month' }));

    await waitFor(() => expect(app.url()).toContain(`asOf=${last}`));
    await waitFor(() => expect(app.asked).toContain(last));
  });

  it('offers exactly two quick picks', async () => {
    renderApp();

    const popover = await open();
    const chips = within(within(popover).getByRole('group', { name: 'Quick picks' }))
      .getAllByRole('button')
      .map((chip) => chip.textContent);

    expect(chips).toEqual(['Today', 'End of last month']);
  });

  it('disables dates after today and navigation past this month', async () => {
    renderApp();

    const popover = await open();
    const grid = within(popover).getByRole('group', { name: /\d{4}$/ });
    const days = within(grid).getAllByRole('button');
    const todayIndex = days.findIndex((day) => day.getAttribute('aria-current') === 'date');

    expect(within(popover).getByRole('button', { name: 'Next month' })).toBeDisabled();
    expect(days[todayIndex]).toBeEnabled();
    for (const day of days.slice(todayIndex + 1)) expect(day).toBeDisabled();
    expect(
      within(popover).getByText('Dates after today show a projection, not a balance.'),
    ).toBeInTheDocument();
  });
});

describe('a past date', () => {
  const PAST = '2026-08-31';
  const pastUrl = `/transactions?account=${CHECKING}&asOf=${PAST}`;

  it('reproduces the view from the URL and treats the past date everywhere at once', async () => {
    const app = renderApp({ url: pastUrl });

    await within(sidebar()).findByText('4,850.00');

    expect(app.asked).toEqual([PAST]);
    expect(screen.getAllByText(`As of ${formatAsOf(PAST)}`)).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: `Balances as of ${formatAsOf(PAST)}` }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Transactions below are not filtered by this date/),
    ).toBeInTheDocument();
  });

  it('removes asOf from the URL rather than writing today into it', async () => {
    const app = renderApp({ url: pastUrl });

    fireEvent.click(await screen.findByRole('button', { name: 'Back to today' }));

    await waitFor(() => expect(app.url()).not.toContain('asOf'));
    expect(app.url()).toContain(`account=${CHECKING}`);
    expect(screen.getAllByText('As of today').length).toBeGreaterThan(0);
  });

  it('ignores a future date pasted into the URL', async () => {
    const app = renderApp({ url: `/transactions?account=${CHECKING}&asOf=2099-01-01` });

    await within(sidebar()).findByText('4,850.00');
    expect(app.asked).toEqual([localIsoDate(new Date())]);
    expect(screen.queryByRole('button', { name: 'Back to today' })).not.toBeInTheDocument();
  });
});

describe('balance request states', () => {
  it('renders names immediately while figures shimmer', async () => {
    renderApp({
      balances: async () => {
        await delay('infinite');
        return HttpResponse.json(balances);
      },
    });

    expect(await screen.findByRole('button', { name: /Everyday Checking/ })).toBeInTheDocument();
    expect(screen.getAllByText('Loading balance').length).toBeGreaterThan(0);
    expect(screen.queryByText('4,850.00')).not.toBeInTheDocument();
  });

  it('falls back to a dash with one retryable message carrying the problem detail', async () => {
    let attempt = 0;
    renderApp({
      balances: () => {
        attempt += 1;
        return attempt === 1
          ? problem(503, 'The database did not respond in time.')
          : HttpResponse.json(balances);
      },
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The database did not respond in time.');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByText('Balance unavailable').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Everyday Checking/ })).toBeInTheDocument();
    expect(await screen.findByText('No transactions yet')).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await screen.findAllByText('4,850.00')).not.toHaveLength(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
