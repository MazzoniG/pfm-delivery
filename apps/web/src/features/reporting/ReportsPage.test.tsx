import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import { setupServer } from 'msw/node';
import { delay, http, HttpResponse } from 'msw';
import {
  API_PREFIX,
  routes,
  type BalancesResponseWire,
  type CategoryLinesWire,
  type CategoryReportWire,
  type LedgerAccount,
  type MonthSpendingWire,
} from '@pfm/contracts';
import { ReportsPage } from './ReportsPage.jsx';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Only Date is faked: "today" is the mock-up's 2026-09-21, so the default range
// is April to September and September is the partial month.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 21, 12, 0, 0));
});
afterEach(() => vi.useRealTimers());

const CHECKING = '11111111-1111-4111-8111-111111111111';
const VISA = '33333333-3333-4333-8333-333333333333';

const GROCERIES = 'a0000000-0000-4000-8000-000000000001';
const HOME = 'a0000000-0000-4000-8000-000000000002';
const UTILITIES = 'a0000000-0000-4000-8000-000000000003';
const DINING = 'a0000000-0000-4000-8000-000000000004';
const FUEL = 'a0000000-0000-4000-8000-000000000005';
const HOUSEHOLD = 'a0000000-0000-4000-8000-000000000006';
const SUBSCRIPTIONS = 'a0000000-0000-4000-8000-000000000007';
const PROJECT = 'b0000000-0000-4000-8000-000000000001';

const entryId = (n: number) => `e0000000-0000-4000-8000-${`${n}`.padStart(12, '0')}`;
const lineId = (n: number) => `f0000000-0000-4000-8000-${`${n}`.padStart(12, '0')}`;

const account = (id: string, name: string, kind: LedgerAccount['kind']): LedgerAccount => ({
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
  account(VISA, 'Visa Credit Card', 'liability'),
];

const balances: BalancesResponseWire = {
  asOf: '2026-09-21',
  accounts: [
    { ledgerAccountId: CHECKING, kind: 'asset', archived: false, balanceMinor: '485000' },
    { ledgerAccountId: VISA, kind: 'liability', archived: false, balanceMinor: '80000' },
  ],
  subtotals: { asset: '485000', liability: '80000' },
  netWorthMinor: '405000',
};

const september: MonthSpendingWire = {
  month: '2026-09',
  totalMinor: '69198',
  categories: [
    { ledgerAccountId: GROCERIES, name: 'Groceries', totalMinor: '21765', includesCorrection: true },
    { ledgerAccountId: HOME, name: 'Home Improvement', totalMinor: '20000', includesCorrection: false },
    { ledgerAccountId: UTILITIES, name: 'Utilities', totalMinor: '8814', includesCorrection: false },
    { ledgerAccountId: DINING, name: 'Dining', totalMinor: '8780', includesCorrection: true },
    { ledgerAccountId: FUEL, name: 'Fuel', totalMinor: '5240', includesCorrection: false },
    { ledgerAccountId: HOUSEHOLD, name: 'Household', totalMinor: '3000', includesCorrection: false },
    { ledgerAccountId: SUBSCRIPTIONS, name: 'Subscriptions', totalMinor: '1599', includesCorrection: false },
  ],
};

const august: MonthSpendingWire = {
  month: '2026-08',
  totalMinor: '239218',
  categories: [
    { ledgerAccountId: HOME, name: 'Home Improvement', totalMinor: '150000', includesCorrection: false },
    { ledgerAccountId: GROCERIES, name: 'Groceries', totalMinor: '60000', includesCorrection: false },
    { ledgerAccountId: FUEL, name: 'Fuel', totalMinor: '29218', includesCorrection: false },
  ],
};

const july: MonthSpendingWire = { month: '2026-07', totalMinor: '0', categories: [] };

const simpleMonth = (month: string, totalMinor: string): MonthSpendingWire => ({
  month,
  totalMinor,
  categories: [
    { ledgerAccountId: GROCERIES, name: 'Groceries', totalMinor, includesCorrection: false },
  ],
});

const report = (overrides: Partial<Record<string, MonthSpendingWire>> = {}): CategoryReportWire => ({
  from: '2026-04-01',
  to: '2026-09-30',
  months: [
    overrides['2026-04'] ?? simpleMonth('2026-04', '243120'),
    overrides['2026-05'] ?? simpleMonth('2026-05', '231875'),
    overrides['2026-06'] ?? simpleMonth('2026-06', '261004'),
    overrides['2026-07'] ?? july,
    overrides['2026-08'] ?? august,
    overrides['2026-09'] ?? september,
  ],
});

const groceriesLines: CategoryLinesWire = {
  ledgerAccountId: GROCERIES,
  from: '2026-09-01',
  to: '2026-09-30',
  lines: [
    {
      entryId: entryId(1),
      lineId: lineId(1),
      occurredOn: '2026-09-20',
      payee: 'Riverside Café',
      accounts: [{ ledgerAccountId: CHECKING, name: 'Everyday Checking' }],
      amountMinor: '-2400',
      reverses: { id: entryId(90), occurredOn: '2026-08-14' },
      reversedBy: null,
      replaces: null,
    },
    {
      entryId: entryId(2),
      lineId: lineId(2),
      occurredOn: '2026-09-19',
      payee: 'Corner Market',
      accounts: [{ ledgerAccountId: CHECKING, name: 'Everyday Checking' }],
      amountMinor: '5420',
      reverses: null,
      reversedBy: null,
      replaces: null,
    },
    {
      entryId: entryId(3),
      lineId: lineId(3),
      occurredOn: '2026-09-11',
      payee: 'Fresh Fields Market',
      accounts: [{ ledgerAccountId: VISA, name: 'Visa Credit Card' }],
      amountMinor: '11295',
      reverses: null,
      reversedBy: null,
      replaces: null,
    },
    {
      entryId: entryId(4),
      lineId: lineId(4),
      occurredOn: '2026-09-04',
      payee: 'Warehouse Club',
      accounts: [
        { ledgerAccountId: CHECKING, name: 'Everyday Checking' },
        { ledgerAccountId: VISA, name: 'Visa Credit Card' },
      ],
      amountMinor: '7450',
      reverses: null,
      reversedBy: null,
      replaces: null,
    },
  ],
};

const diningLines: CategoryLinesWire = {
  ledgerAccountId: DINING,
  from: '2026-09-01',
  to: '2026-09-30',
  lines: [
    {
      entryId: entryId(5),
      lineId: lineId(5),
      occurredOn: '2026-09-20',
      payee: 'Riverside Café',
      accounts: [{ ledgerAccountId: CHECKING, name: 'Everyday Checking' }],
      amountMinor: '2400',
      reverses: null,
      reversedBy: null,
      replaces: { id: entryId(90), occurredOn: '2026-08-14' },
    },
    {
      entryId: entryId(6),
      lineId: lineId(6),
      occurredOn: '2026-09-02',
      payee: 'Noodle Bar',
      accounts: [{ ledgerAccountId: VISA, name: 'Visa Credit Card' }],
      amountMinor: '6380',
      reverses: null,
      reversedBy: null,
      replaces: null,
    },
  ],
};

const problem = (status: number, detail: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: 'Bad Request', status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const Url = () => <span data-testid="url">{useLocation().search}</span>;

type Options = {
  url?: string;
  report?: () => Promise<Response> | Response;
  lines?: Record<string, CategoryLinesWire>;
};

const REPORT_PATH = `*${API_PREFIX}${routes.categoryReport}`;
const LINES_PATH = `*${API_PREFIX}${routes.categoryReportLines(':ledgerAccountId')}`;

const renderReport = ({
  url = '/reports/categories?from=2026-04-01&to=2026-09-30',
  ...options
}: Options = {}) => {
  const reportRequests: URL[] = [];
  const linesRequests: URL[] = [];
  const lines = options.lines ?? { [GROCERIES]: groceriesLines, [DINING]: diningLines };

  server.use(
    http.get('*/api/v1/accounts/balances', () => HttpResponse.json(balances)),
    http.get('*/api/v1/accounts', () => HttpResponse.json(accounts)),
    http.get(LINES_PATH, ({ request, params }) => {
      linesRequests.push(new URL(request.url));
      const body = lines[params['ledgerAccountId'] as string];
      return body ? HttpResponse.json(body) : problem(404, 'No such category.');
    }),
    http.get(REPORT_PATH, async ({ request }) => {
      reportRequests.push(new URL(request.url));
      return options.report ? await options.report() : HttpResponse.json(report());
    }),
  );

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <ReportsPage />
        <Url />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return {
    reportRequests,
    linesRequests,
    search: () => new URLSearchParams(screen.getByTestId('url').textContent ?? ''),
  };
};

const chart = () => screen.getByRole('heading', { name: 'Spending per month' }).parentElement!;
const monthBars = () => within(chart()).getAllByRole('button');
const monthBar = (short: string) =>
  within(chart()).getByRole('button', { name: new RegExp(`^${short}`) });

/** Every figure a user can read in the chart, visible text or accessible name. */
const chartFigures = () =>
  `${chart().textContent ?? ''} ${monthBars()
    .map((b) => b.getAttribute('aria-label') ?? '')
    .join(' ')}`;

const categoryTable = (monthLong: string) =>
  screen.getByRole('table', { name: `Spending by category, ${monthLong}` });

const categoryToggles = (table: HTMLElement) =>
  within(table).getAllByRole('button').filter((b) => b.hasAttribute('aria-expanded'));

const categoryRow = (name: string) =>
  screen.getByRole('button', { name, expanded: false }).closest('tr')! as HTMLElement;

const monthTotal = () => screen.getByText('Total spent').parentElement! as HTMLElement;

const MINUS = '[-−]';

describe('navigation', () => {
  it('lists exactly Transactions, Bills, Reports, Projects and Insights, with Reports current', async () => {
    renderReport();

    const nav = screen.getByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');

    expect(links.map((l) => l.textContent?.trim())).toEqual([
      'Transactions',
      'Bills',
      'Reports',
      'Projects',
      'Insights',
    ]);
    expect(within(nav).getByRole('link', { name: 'Reports' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Transactions' })).not.toHaveAttribute('aria-current');
  });

  it('keeps the accounts sidebar', async () => {
    renderReport();

    const sidebar = screen.getByRole('navigation', { name: 'Accounts' });
    expect(await within(sidebar).findByText('Everyday Checking')).toBeInTheDocument();
    expect(within(sidebar).getByText('Visa Credit Card')).toBeInTheDocument();
  });
});

describe('the month series', () => {
  it('draws one bar per month from the API, each figure the API string through the formatter', async () => {
    renderReport();

    await screen.findByRole('table', { name: /Spending by category/ });

    expect(monthBars()).toHaveLength(6);
    const figures = chartFigures();
    for (const figure of ['2,431.20', '2,318.75', '2,610.04', '0.00', '2,392.18', '691.98']) {
      expect(figures).toContain(figure);
    }
  });

  it('keeps a zero month as a selectable bar and shows the empty state for it', async () => {
    const app = renderReport({ url: '/reports/categories?from=2026-04-01&to=2026-09-30&month=2026-07' });

    expect(
      await screen.findByRole('heading', { name: 'No spending in July 2026' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Nothing was spent this month, or everything was excluded from reports.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(monthBar('Jul')).toHaveAttribute('aria-pressed', 'true');
    expect(app.search().get('month')).toBe('2026-07');
  });

  it('reaches the zero month by clicking its bar', async () => {
    const app = renderReport();

    await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    fireEvent.click(monthBar('Jul'));

    expect(await screen.findByRole('heading', { name: 'No spending in July 2026' })).toBeInTheDocument();
    expect(app.search().get('month')).toBe('2026-07');
  });
});

describe('selecting a month', () => {
  it('selects the latest month in range when the URL has no month', async () => {
    const app = renderReport();

    expect(
      await screen.findByRole('table', { name: 'Spending by category, September 2026' }),
    ).toBeInTheDocument();
    expect(monthBar('Sep')).toHaveAttribute('aria-pressed', 'true');
    for (const short of ['Apr', 'May', 'Jun', 'Jul', 'Aug']) {
      expect(monthBar(short)).toHaveAttribute('aria-pressed', 'false');
    }
    expect(within(monthTotal()).getByText('691.98')).toBeInTheDocument();
    expect(app.search().get('month')).toBeNull();
  });

  it('marks the current month as partial, to date', async () => {
    renderReport();

    await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    expect(screen.getByText(/1 to 21, to date/)).toBeInTheDocument();
  });

  it('updates the chart, the table, the total and the URL together, without a new report request', async () => {
    const app = renderReport();

    await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    fireEvent.click(monthBar('Aug'));

    await waitFor(() => expect(app.search().get('month')).toBe('2026-08'));
    expect(app.search().get('from')).toBe('2026-04-01');
    expect(app.search().get('to')).toBe('2026-09-30');

    const table = categoryTable('August 2026');
    expect(categoryToggles(table).map((b) => b.textContent?.trim())).toEqual([
      'Home Improvement',
      'Groceries',
      'Fuel',
    ]);
    expect(screen.queryByRole('table', { name: /September 2026/ })).not.toBeInTheDocument();

    expect(monthBar('Aug')).toHaveAttribute('aria-pressed', 'true');
    expect(monthBar('Sep')).toHaveAttribute('aria-pressed', 'false');

    expect(within(monthTotal()).getByText('2,392.18')).toBeInTheDocument();
    expect(screen.queryByText(/to date/)).not.toBeInTheDocument();

    expect(app.reportRequests).toHaveLength(1);
  });

  it('reproduces the selected month from the URL', async () => {
    renderReport({ url: '/reports/categories?from=2026-04-01&to=2026-09-30&month=2026-08' });

    expect(await screen.findByRole('table', { name: 'Spending by category, August 2026' })).toBeInTheDocument();
    expect(monthBar('Aug')).toHaveAttribute('aria-pressed', 'true');
    expect(within(monthTotal()).getByText('2,392.18')).toBeInTheDocument();
  });
});

describe('the request', () => {
  it('asks for the last six whole months by default', async () => {
    const app = renderReport({ url: '/reports/categories' });

    await screen.findByRole('table', { name: /Spending by category/ });
    const sent = app.reportRequests[0]!.searchParams;
    expect(sent.get('from')).toBe('2026-04-01');
    expect(sent.get('to')).toBe('2026-09-30');
  });

  it('passes the URL period through and never sends month or projectId', async () => {
    const app = renderReport({
      url: `/reports/categories?from=2026-04-01&to=2026-09-30&month=2026-09&projectId=${PROJECT}`,
    });

    await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    fireEvent.click(screen.getByRole('button', { name: 'Groceries', expanded: false }));
    await waitFor(() => expect(app.linesRequests).toHaveLength(1));

    expect(app.reportRequests).toHaveLength(1);
    const sent = app.reportRequests[0]!.searchParams;
    expect(sent.get('from')).toBe('2026-04-01');
    expect(sent.get('to')).toBe('2026-09-30');
    for (const url of [...app.reportRequests, ...app.linesRequests]) {
      expect(url.searchParams.has('projectId')).toBe(false);
      expect(url.searchParams.has('month')).toBe(false);
    }
  });
});

describe('the category table', () => {
  it('shows the API month total even when it disagrees with the rows', async () => {
    renderReport({
      report: () => HttpResponse.json(report({ '2026-09': { ...september, totalMinor: '75000' } })),
    });

    await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    expect(within(monthTotal()).getByText('750.00')).toBeInTheDocument();
    // What a browser-side sum over the visible rows would have produced.
    expect(screen.queryByText('691.98')).not.toBeInTheDocument();
  });

  it('renders categories in API order with their API figures', async () => {
    renderReport();

    const table = await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    expect(categoryToggles(table).map((b) => b.textContent?.trim())).toEqual([
      'Groceries',
      'Home Improvement',
      'Utilities',
      'Dining',
      'Fuel',
      'Household',
      'Subscriptions',
    ]);
    expect(within(categoryRow('Groceries')).getByText('217.65')).toBeInTheDocument();
    expect(within(categoryRow('Utilities')).getByText('88.14')).toBeInTheDocument();
    expect(within(categoryRow('Subscriptions')).getByText('15.99')).toBeInTheDocument();
  });

  it('badges exactly the categories flagged as including a correction', async () => {
    renderReport();

    const table = await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    const flagged = categoryToggles(table)
      .filter((b) => within(b.closest('tr')!).queryByText('Includes a correction'))
      .map((b) => b.textContent?.trim());

    expect(flagged).toEqual(['Groceries', 'Dining']);
  });

  it('keeps a negative category total signed and explains it in one line', async () => {
    renderReport({
      report: () =>
        HttpResponse.json(
          report({
            '2026-09': {
              month: '2026-09',
              totalMinor: '17600',
              categories: [
                { ledgerAccountId: DINING, name: 'Dining', totalMinor: '20000', includesCorrection: true },
                { ledgerAccountId: GROCERIES, name: 'Groceries', totalMinor: '-2400', includesCorrection: true },
              ],
            },
          }),
        ),
    });

    await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    const row = categoryRow('Groceries');

    expect(within(row).getByText(new RegExp(`^${MINUS}24\\.00$`))).toBeInTheDocument();
    expect(
      within(row).getByText(
        'Below zero because a correction this month moved spending out of this category.',
      ),
    ).toBeInTheDocument();
    expect(within(row).getByText('Includes a correction')).toBeInTheDocument();

    const positive = categoryRow('Dining');
    expect(within(positive).getByText('200.00')).toBeInTheDocument();
    expect(within(positive).queryByText(/Below zero/)).not.toBeInTheDocument();
    expect(within(monthTotal()).getByText('176.00')).toBeInTheDocument();
  });

  it('carries the footnote about lines excluded from reports', async () => {
    renderReport();

    await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    expect(
      screen.getByText('Transactions marked as excluded from reports are not counted.'),
    ).toBeInTheDocument();
  });
});

describe('expanding a category', () => {
  it('fetches the lines only when opened, for the selected month', async () => {
    const app = renderReport();

    await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    expect(app.linesRequests).toHaveLength(0);
    expect(screen.queryByText('Corner Market')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Groceries', expanded: false });
    fireEvent.click(toggle);

    expect(await screen.findByText('Corner Market')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(app.linesRequests).toHaveLength(1);

    const sent = app.linesRequests[0]!;
    expect(sent.pathname).toBe(`${API_PREFIX}${routes.categoryReportLines(GROCERIES)}`);
    expect(sent.searchParams.get('from')).toBe('2026-09-01');
    expect(sent.searchParams.get('to')).toBe('2026-09-30');
  });

  it('shows category-side amounts: spending positive, the reversal negative', async () => {
    renderReport();

    await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    fireEvent.click(screen.getByRole('button', { name: 'Groceries', expanded: false }));

    const reversal = (await screen.findByText('Riverside Café')).closest('tr')! as HTMLElement;
    expect(within(reversal).getByText(new RegExp(`^${MINUS}24\\.00$`))).toBeInTheDocument();
    expect(within(reversal).getByText('Everyday Checking')).toBeInTheDocument();

    const purchase = screen.getByText('Corner Market').closest('tr')! as HTMLElement;
    expect(within(purchase).getByText('54.20')).toBeInTheDocument();
    expect(purchase.textContent).not.toMatch(new RegExp(MINUS));

    const card = screen.getByText('Fresh Fields Market').closest('tr')! as HTMLElement;
    expect(within(card).getByText('112.95')).toBeInTheDocument();
    expect(within(card).getByText('Visa Credit Card')).toBeInTheDocument();
  });

  it('collapses a purchase paid from two accounts to —Split—', async () => {
    renderReport();

    await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    fireEvent.click(screen.getByRole('button', { name: 'Groceries', expanded: false }));

    const split = (await screen.findByText('Warehouse Club')).closest('tr')! as HTMLElement;
    expect(within(split).getByText('—Split—')).toBeInTheDocument();
    expect(within(split).queryByText('Everyday Checking')).not.toBeInTheDocument();
    expect(within(split).getByText('74.50')).toBeInTheDocument();
  });

  it('badges the reversal with a link that takes you to the original’s month', async () => {
    const app = renderReport();

    await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    fireEvent.click(screen.getByRole('button', { name: 'Groceries', expanded: false }));

    const reversal = (await screen.findByText('Riverside Café')).closest('tr')! as HTMLElement;
    const link = within(reversal).getByRole('link', { name: /Reversal of Aug 14/ });

    fireEvent.click(link);

    await waitFor(() => expect(app.search().get('month')).toBe('2026-08'));
    expect(await screen.findByRole('table', { name: 'Spending by category, August 2026' })).toBeInTheDocument();
    expect(monthBar('Aug')).toHaveAttribute('aria-pressed', 'true');
  });

  it('marks the replacement line distinctly, linking to the original’s month', async () => {
    const app = renderReport();

    await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    fireEvent.click(screen.getByRole('button', { name: 'Dining', expanded: false }));

    const replacement = (await screen.findByText('Riverside Café')).closest('tr')! as HTMLElement;
    const plain = screen.getByText('Noodle Bar').closest('tr')! as HTMLElement;

    expect(within(replacement).getByText('24.00')).toBeInTheDocument();
    expect(within(plain).queryByRole('link')).not.toBeInTheDocument();

    fireEvent.click(within(replacement).getByRole('link', { name: /Aug 14/ }));
    await waitFor(() => expect(app.search().get('month')).toBe('2026-08'));
  });

  it('fetches each category separately and none for unopened ones', async () => {
    const app = renderReport();

    await screen.findByRole('table', { name: 'Spending by category, September 2026' });
    fireEvent.click(screen.getByRole('button', { name: 'Dining', expanded: false }));
    await screen.findByText('Noodle Bar');

    expect(app.linesRequests.map((u) => u.pathname)).toEqual([
      `${API_PREFIX}${routes.categoryReportLines(DINING)}`,
    ]);
  });
});

describe('report states', () => {
  it('keeps the chart geometry while loading and shows no figures', async () => {
    renderReport({
      report: async () => {
        await delay('infinite');
        return HttpResponse.json(report());
      },
    });

    expect(screen.getByRole('heading', { name: 'Spending per month' })).toBeInTheDocument();
    for (const short of ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']) {
      expect(within(chart()).getByText(short)).toBeInTheDocument();
    }
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('691.98')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the problem detail as written, with a Try again that recovers', async () => {
    let attempt = 0;
    const app = renderReport({
      report: () => {
        attempt += 1;
        return attempt === 1
          ? problem(400, 'The date range is invalid: from must be on or before to.')
          : HttpResponse.json(report());
      },
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/^The date range is invalid: from must be on or before to\.$/);
    expect(screen.getByText(/The report didn.t load/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('table', { name: 'Spending by category, September 2026' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(app.reportRequests).toHaveLength(2);
  });
});
