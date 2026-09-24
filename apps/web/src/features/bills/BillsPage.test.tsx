import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  MemoryRouter,
  Route,
  Routes,
  RouterProvider,
  createMemoryRouter,
  useLocation,
} from 'react-router';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import type {
  BalancesResponseWire,
  Category,
  LedgerAccount,
  PayOccurrenceResponseWire,
  ProjectionResponseWire,
  RecurringSeriesWire,
  ScheduledOccurrenceViewWire,
} from '@pfm/contracts';
import { BillsPage } from './BillsPage.jsx';

// US4 on the web side. The criteria are the numbered notes in
// docs/mockups/bills.html and the two contract modules the page is built on.
//
// Recharts is stubbed so the chart's own contribution — which points are solid,
// which dashed, and where the boundary sits — can be asserted as data rather
// than as SVG that jsdom lays out at zero width. Nothing else is mocked; the
// figures a user reads come from MSW responses shaped by the contract's wire
// types, and no amount asserted here passes through a JS `number`.

type ChartStub = {
  children?: ReactNode;
  data?: unknown[];
  dataKey?: string;
  strokeDasharray?: string;
  x?: string;
  label?: { value?: string };
  ticks?: string[];
};

vi.mock('recharts', async () => {
  const { createElement } = await import('react');
  return {
    ResponsiveContainer: ({ children }: ChartStub) => createElement('div', null, children),
    LineChart: ({ data, children }: ChartStub) =>
      createElement(
        'div',
        { 'data-testid': 'chart', 'data-points': JSON.stringify(data) },
        children,
      ),
    Line: ({ dataKey, strokeDasharray }: ChartStub) =>
      createElement('div', {
        'data-testid': `line-${String(dataKey)}`,
        'data-dashed': strokeDasharray === undefined ? 'false' : 'true',
      }),
    ReferenceLine: ({ x, label }: ChartStub) =>
      createElement('div', {
        'data-testid': 'boundary',
        'data-x': String(x),
        'data-label': String(label?.value ?? ''),
      }),
    XAxis: ({ ticks }: ChartStub) =>
      createElement('div', { 'data-testid': 'xaxis', 'data-ticks': JSON.stringify(ticks) }),
    CartesianGrid: () => null,
  };
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  asked.length = 0;
  posted.length = 0;
});
afterAll(() => server.close());

/** The mock-up's own day, so the fixtures below read as it does. */
const TODAY = '2026-09-22';
const ONE_MONTH = '2026-10-22';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 22, 9, 30));
});
afterEach(() => vi.useRealTimers());

const CHECKING = '11111111-1111-4111-8111-111111111111';
const VISA = '22222222-2222-4222-8222-222222222222';
const RENT = '33333333-3333-4333-8333-333333333333';
const UTILITIES = '44444444-4444-4444-8444-444444444444';
const SALARY = '55555555-5555-4555-8555-555555555555';
const SERIES_RENT = '66666666-6666-4666-8666-666666666666';
const SERIES_PAY = '77777777-7777-4777-8777-777777777777';
const OCC_WATER = '88888888-8888-4888-8888-888888888888';
const OCC_PARKING = '99999999-9999-4999-8999-999999999999';
const OCC_SALARY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OCC_RENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OCC_GYM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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

const category = (id: string, name: string, kind: Category['kind']): Category => ({
  id,
  name,
  kind,
  isSystem: false,
  archivedAt: null,
  createdAt: '2026-04-01T09:00:00.000Z',
});

const expenses = [
  category(RENT, 'Rent', 'expense'),
  category(UTILITIES, 'Utilities', 'expense'),
];
const incomes = [category(SALARY, 'Salary', 'income')];

const balances: BalancesResponseWire = {
  asOf: TODAY,
  accounts: [
    { ledgerAccountId: CHECKING, kind: 'asset', archived: false, balanceMinor: '581334' },
    { ledgerAccountId: VISA, kind: 'liability', archived: false, balanceMinor: '37384' },
  ],
  subtotals: { asset: '581334', liability: '37384' },
  netWorthMinor: '1954833',
};

const occurrence = (
  over: Partial<ScheduledOccurrenceViewWire> & { id: string; dueOn: string; amountMinor: string },
): ScheduledOccurrenceViewWire => ({
  seriesId: SERIES_RENT,
  payee: 'Harbor Apartments',
  rule: { frequency: 'monthly', dayOfMonth: 1 },
  ledgerAccountId: CHECKING,
  ledgerAccountName: 'Everyday Checking',
  categoryId: RENT,
  categoryName: 'Rent',
  ...over,
});

const salaryRow = occurrence({
  id: OCC_SALARY,
  dueOn: '2026-09-25',
  amountMinor: '242990',
  seriesId: SERIES_PAY,
  payee: 'Acme Corp Payroll',
  rule: { frequency: 'biweekly' },
  categoryId: SALARY,
  categoryName: 'Salary',
});

const rentRow = occurrence({ id: OCC_RENT, dueOn: '2026-10-01', amountMinor: '-165000' });

const gymRow = occurrence({
  id: OCC_GYM,
  dueOn: '2026-10-05',
  amountMinor: '-3500',
  payee: 'Riverside Fitness',
  rule: { frequency: 'monthly', dayOfMonth: 5 },
  ledgerAccountId: VISA,
  ledgerAccountName: 'Visa Credit Card',
  categoryName: 'Fitness',
});

const waterRow = occurrence({
  id: OCC_WATER,
  dueOn: '2026-09-19',
  amountMinor: '-6420',
  payee: 'Riverside Water',
  rule: { frequency: 'monthly', dayOfMonth: 19 },
  categoryId: UTILITIES,
  categoryName: 'Utilities',
});

const parkingRow = occurrence({
  id: OCC_PARKING,
  dueOn: '2026-09-20',
  amountMinor: '-1000',
  payee: 'City Parking',
  rule: { frequency: 'one-off' },
  categoryId: UTILITIES,
  categoryName: 'Utilities',
});

/**
 * The rows deliberately do not add up to either group's `netMinor`, and
 * `projectedNetWorthMinor` is deliberately not `netWorthMinor` plus either of
 * them — a legal response, since the ledger half of the forecast also carries
 * future-dated real entries the client never sees. Any figure the client added
 * up itself would therefore render a different string from the API's.
 *
 *   rows scheduled  +2,429.90 −1,650.00 −35.00  =    +744.90, net says +3,043.53
 *   rows overdue      −64.20 −10.00            =     −74.20, net says −99.99
 *   net worth 19,548.33 + scheduled net        =  22,591.86, projected says 23,591.86
 */
const projection: ProjectionResponseWire = {
  asOf: TODAY,
  to: ONE_MONTH,
  netWorthMinor: '1954833',
  projectedNetWorthMinor: '2359186',
  series: [
    { on: '2026-08-22', netWorthMinor: '1800000', basis: 'actual' },
    { on: '2026-09-10', netWorthMinor: '1900000', basis: 'actual' },
    { on: TODAY, netWorthMinor: '1954833', basis: 'actual' },
    { on: '2026-09-25', netWorthMinor: '2197823', basis: 'projected' },
    { on: '2026-10-01', netWorthMinor: '2032823', basis: 'projected' },
    { on: ONE_MONTH, netWorthMinor: '2359186', basis: 'projected' },
  ],
  overdue: { netMinor: '-9999', occurrences: [waterRow, parkingRow] },
  scheduled: { netMinor: '304353', occurrences: [salaryRow, rentRow, gymRow] },
};

const empty: ProjectionResponseWire = {
  ...projection,
  projectedNetWorthMinor: '1954833',
  overdue: { netMinor: '0', occurrences: [] },
  scheduled: { netMinor: '0', occurrences: [] },
};

const asked: string[] = [];
const posted: { url: string; body: unknown }[] = [];

const series: RecurringSeriesWire = {
  id: SERIES_RENT,
  payee: 'Harbor Apartments',
  amountMinor: '-165000',
  ledgerAccountId: CHECKING,
  categoryId: RENT,
  rule: { frequency: 'monthly', dayOfMonth: 1 },
  firstDueOn: '2026-10-01',
  endsOn: null,
  createdAt: '2026-09-22T09:30:00.000Z',
};

const paid: PayOccurrenceResponseWire = {
  occurrence: {
    id: OCC_RENT,
    seriesId: SERIES_RENT,
    dueOn: '2026-10-01',
    amountMinor: '-165000',
    materializedEntryId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  },
  entry: {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    occurredOn: '2026-10-01',
    description: null,
    payee: 'Harbor Apartments',
    memo: null,
    lockedAt: null,
    reversesEntryId: null,
    replacesEntryId: null,
    reversedByEntryId: null,
    recordedAt: '2026-09-22T09:30:00.000Z',
    lines: [
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        ledgerAccountId: CHECKING,
        ledgerAccountName: 'Everyday Checking',
        ledgerAccountKind: 'asset',
        amountMinor: '-165000',
        projectId: null,
        excludedFromReporting: false,
        reconciledAt: null,
      },
      {
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        ledgerAccountId: RENT,
        ledgerAccountName: 'Rent',
        ledgerAccountKind: 'expense',
        amountMinor: '165000',
        projectId: null,
        excludedFromReporting: false,
        reconciledAt: null,
      },
    ],
  },
};

const handlers = (body: ProjectionResponseWire | 'pending' = projection) => [
  http.get('/api/v1/accounts', () => HttpResponse.json(accounts)),
  http.get('/api/v1/accounts/balances', () => HttpResponse.json(balances)),
  http.get('/api/v1/categories', ({ request }) =>
    HttpResponse.json(
      new URL(request.url).searchParams.get('kind') === 'income' ? incomes : expenses,
    ),
  ),
  http.get('/api/v1/projection', ({ request }) => {
    asked.push(new URL(request.url).searchParams.get('to') ?? '');
    if (body === 'pending') return new Promise<never>(() => {});
    return HttpResponse.json(body);
  }),
  http.post('/api/v1/recurring', async ({ request }) => {
    posted.push({ url: request.url, body: await request.json() });
    return HttpResponse.json(series, { status: 201 });
  }),
  http.post('/api/v1/occurrences/:id/pay', async ({ request }) => {
    posted.push({ url: request.url, body: await request.json() });
    return HttpResponse.json(paid, { status: 201 });
  }),
];

const Probe = () => <span data-testid="url">{useLocation().search}</span>;

const renderPage = (entry = '/bills') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/bills"
            element={
              <>
                <BillsPage />
                <Probe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const url = () => screen.getByTestId('url').textContent ?? '';
const seeRent = () => screen.findByText('Harbor Apartments');

// ---------------------------------------------------------------------------
// Note 1 — the rail gains a Bills item, and the page says what it is.

describe('the page itself', () => {
  it('names itself, marks the rail, and says these are not in the ledger yet', async () => {
    server.use(...handlers());
    renderPage();
    await seeRent();

    expect(screen.getByRole('heading', { name: 'Bills and income' })).toBeInTheDocument();
    expect(screen.getByText('Scheduled, not yet in the ledger')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bills' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

// ---------------------------------------------------------------------------
// Note 2 — the horizon lives in the URL as a date.

describe('the horizon in the URL', () => {
  it('asks for a month from today when the link carries no date', async () => {
    server.use(...handlers());
    renderPage();

    await seeRent();
    expect(asked).toEqual([ONE_MONTH]);
    expect(url()).toBe('');
  });

  it('keeps meaning “a month from whenever this is opened”, not a frozen date', async () => {
    server.use(...handlers());
    renderPage();
    await seeRent();

    vi.setSystemTime(new Date(2026, 10, 3, 9, 30));
    renderPage();
    await screen.findAllByText('Harbor Apartments');

    // The same link, opened six weeks later, asks for a different horizon.
    expect(asked).toEqual([ONE_MONTH, '2026-12-03']);
  });

  it('honours a pasted date exactly, and presses none of the buttons for it', async () => {
    server.use(...handlers({ ...projection, to: '2026-12-31' }));
    renderPage('/bills?to=2026-12-31');

    await seeRent();
    expect(asked).toEqual(['2026-12-31']);
    expect(screen.getByRole('heading', { name: /Scheduled to Dec 31/ })).toBeInTheDocument();
    for (const months of ['1 month', '3 months', '6 months']) {
      expect(screen.getByRole('button', { name: months })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
  });

  it('writes the date the segmented control means, and leaves the default out', async () => {
    server.use(...handlers({ ...projection, to: '2026-12-22' }));
    renderPage();
    await seeRent();

    fireEvent.click(screen.getByRole('button', { name: '3 months' }));

    await waitFor(() => expect(url()).toBe('?to=2026-12-22'));
    expect(asked).toEqual([ONE_MONTH, '2026-12-22']);
    expect(screen.getByRole('button', { name: '3 months' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // One month is the default and is deliberately not written, so the link
    // keeps meaning "a month from whenever you open it".
    fireEvent.click(screen.getByRole('button', { name: '1 month' }));
    await waitFor(() => expect(url()).toBe(''));
  });

  it('renders whatever the history entry says, so back and forward are correct', async () => {
    server.use(...handlers());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [{ path: '/bills', element: <BillsPage /> }],
      { initialEntries: ['/bills?to=2026-11-22', '/bills?to=2026-12-31'], initialIndex: 1 },
    );
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await seeRent();
    expect(asked).toEqual(['2026-12-31']);

    await router.navigate(-1);
    await waitFor(() => expect(asked).toEqual(['2026-12-31', '2026-11-22']));

    await router.navigate(1);
    await waitFor(() => expect(asked.at(-1)).toBe('2026-12-31'));
  });
});

// ---------------------------------------------------------------------------
// Note 3 — the projected figure is the API's.

describe('the projected figure', () => {
  it('is the API’s number, not the sum of anything on the page', async () => {
    server.use(...handlers());
    renderPage();
    await seeRent();

    expect(await screen.findByText('23,591.86')).toBeInTheDocument();
    // What a client that added up the page would have rendered instead:
    expect(screen.queryByText('22,591.86')).toBeNull(); // net worth + the group's net
    expect(screen.queryByText('20,293.23')).toBeNull(); // net worth + the rows
    expect(screen.queryByText('7,449.00')).toBeNull(); // the rows alone
  });

  it('formats cents beyond 2^53 exactly, so nothing has been through a JS number', async () => {
    server.use(
      ...handlers({
        ...projection,
        projectedNetWorthMinor: '9007199254740993',
        scheduled: { netMinor: '9007199254740993', occurrences: [salaryRow, rentRow, gymRow] },
      }),
    );
    renderPage();

    // 9007199254740993 is not representable as a double; 90,071,992,547,409.92
    // is what a round trip through Number would print.
    expect(await screen.findByText('90,071,992,547,409.93')).toBeInTheDocument();
    expect(screen.queryByText('90,071,992,547,409.92')).toBeNull();
    expect(screen.getByText('net +90,071,992,547,409.93')).toBeInTheDocument();
  });

  it('labels the horizon it is quoted at the way the mock-up does', async () => {
    server.use(...handlers());
    renderPage();
    await seeRent();

    expect(screen.getByText('On Oct 22, 2026')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Note 4 — solid is what happened, dashed is what is scheduled.

describe('the chart', () => {
  const points = (): { on: string; actual: number | null; projected: number | null }[] =>
    JSON.parse(screen.getByTestId('chart').getAttribute('data-points') ?? '[]');

  it('draws the ledger solid, the schedule dashed, and joins them at today', async () => {
    server.use(...handlers());
    renderPage();
    await seeRent();

    expect(screen.getByTestId('line-actual')).toHaveAttribute('data-dashed', 'false');
    expect(screen.getByTestId('line-projected')).toHaveAttribute('data-dashed', 'true');

    const drawn = points();
    expect(drawn.map((point) => point.on)).toEqual(projection.series.map((p) => p.on));

    const boundary = drawn.findIndex((point) => point.on === TODAY);
    for (const [index, point] of drawn.entries()) {
      if (index < boundary) {
        expect(point.actual).not.toBeNull();
        expect(point.projected).toBeNull();
      } else if (index > boundary) {
        expect(point.actual).toBeNull();
        expect(point.projected).not.toBeNull();
      }
    }
    // The boundary point belongs to both lines — the same point, so the dashed
    // half starts where the solid half ends instead of floating away from it.
    expect(drawn[boundary]?.actual).not.toBeNull();
    expect(drawn[boundary]?.projected).toBe(drawn[boundary]?.actual);
  });

  it('puts the marked boundary exactly at today, and nowhere else', async () => {
    server.use(...handlers());
    renderPage();
    await seeRent();

    expect(screen.getByTestId('boundary')).toHaveAttribute('data-x', TODAY);
    expect(screen.getByTestId('boundary')).toHaveAttribute('data-label', 'Today');
    expect(JSON.parse(screen.getByTestId('xaxis').getAttribute('data-ticks') ?? '[]')).toEqual([
      '2026-08-22',
      TODAY,
      ONE_MONTH,
    ]);
  });

  it('names both halves, and says the two figures in words for a screen reader', async () => {
    server.use(...handlers());
    renderPage();
    await seeRent();

    expect(screen.getByText('What happened')).toBeInTheDocument();
    expect(screen.getByText('What is scheduled')).toBeInTheDocument();
    expect(
      screen.getByText(/Balance of 19,548\.33 today, projected to reach 23,591\.86/),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Notes 5 and 6 — the two groups.

describe('the groups', () => {
  it('puts overdue above the forecast and says it is not counted in it', async () => {
    server.use(...handlers());
    renderPage();
    await seeRent();

    const warning = screen.getByText(/past due/).closest('p') as HTMLElement;
    const heading = screen.getByRole('heading', { name: /Scheduled to/ });
    expect(warning.compareDocumentPosition(heading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(warning).toHaveTextContent(
      /not in the projection above, which starts from today’s balance/,
    );
    expect(warning).toHaveTextContent(/change its date/);
  });

  it('totals each group with the API’s net, never with the rows it is showing', async () => {
    server.use(...handlers());
    renderPage();
    await seeRent();

    // Scheduled: three rows worth +744.90, a net of +3,043.53.
    expect(screen.getByText('net +3,043.53')).toBeInTheDocument();
    expect(screen.queryByText('net +744.90')).toBeNull();

    // Overdue: two rows worth −74.20, a net of −99.99.
    expect(screen.getByText(/2 bills are past due, -99\.99 in total/)).toBeInTheDocument();
    expect(screen.queryByText(/74\.20 in total/)).toBeNull();
  });

  it('counts a single overdue bill in the singular', async () => {
    server.use(
      ...handlers({ ...projection, overdue: { netMinor: '-6420', occurrences: [waterRow] } }),
    );
    renderPage();
    await seeRent();

    expect(screen.getByText(/One bill is past due, -64\.20 in total/)).toBeInTheDocument();
  });

  it('shows each row with its date, payee, rule, category, account and signed amount', async () => {
    server.use(...handlers());
    renderPage();
    await seeRent();

    const scheduled = screen.getByRole('table', { name: /Scheduled to/ });
    const rows = within(scheduled).getAllByRole('row');
    expect(rows).toHaveLength(3);

    const salary = within(rows[0] as HTMLElement);
    expect(salary.getByText('Sep 25')).toBeInTheDocument();
    expect(salary.getByText('Acme Corp Payroll')).toBeInTheDocument();
    expect(salary.getByText('Every two weeks')).toBeInTheDocument();
    expect(salary.getByText('Salary, Everyday Checking')).toBeInTheDocument();
    expect(salary.getByText('+2,429.90')).toBeInTheDocument();

    const rent = within(rows[1] as HTMLElement);
    expect(rent.getByText('Oct 01')).toBeInTheDocument();
    expect(rent.getByText('Monthly on the 1st')).toBeInTheDocument();
    expect(rent.getByText('-1,650.00')).toBeInTheDocument();

    // A card charge keeps the net-worth basis: more owed is less net worth.
    const gym = within(rows[2] as HTMLElement);
    expect(gym.getByText('Fitness, Visa Credit Card')).toBeInTheDocument();
    expect(gym.getByText('-35.00')).toBeInTheDocument();

    expect(within(scheduled).getAllByRole('button', { name: 'Mark paid' })).toHaveLength(3);
  });

  it('names the four rules the way the dialog offers them', async () => {
    server.use(
      ...handlers({
        ...projection,
        scheduled: {
          netMinor: '0',
          occurrences: [
            occurrence({ id: OCC_SALARY, dueOn: '2026-09-25', amountMinor: '-100', rule: { frequency: 'one-off' } }),
            occurrence({ id: OCC_RENT, dueOn: '2026-09-26', amountMinor: '-100', rule: { frequency: 'weekly' } }),
            occurrence({ id: OCC_GYM, dueOn: '2026-09-27', amountMinor: '-100', rule: { frequency: 'biweekly' } }),
            occurrence({ id: OCC_PARKING, dueOn: '2026-09-28', amountMinor: '-100', rule: { frequency: 'monthly', dayOfMonth: 31 } }),
          ],
        },
      }),
    );
    renderPage();

    const scheduled = await screen.findByRole('table', { name: /Scheduled to/ });
    expect(
      within(scheduled)
        .getAllByRole('row')
        .map((row) => within(row).getByText(/One-off|Weekly|Every two weeks|Monthly/).textContent),
    ).toEqual(['One-off', 'Weekly', 'Every two weeks', 'Monthly on the 31st']);
  });
});

// ---------------------------------------------------------------------------
// Note 7 and dialog notes 4–5 — Mark paid.

describe('the Mark paid dialog', () => {
  const open = async (payee = 'Harbor Apartments') => {
    server.use(...handlers());
    renderPage();
    const row = (await screen.findByText(payee)).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Mark paid' }));
    return screen.findByRole('dialog');
  };

  it('prefills the date and amount from the schedule, and says what it will do', async () => {
    const dialog = await open();

    expect(within(dialog).getByLabelText('Paid on')).toHaveValue('2026-10-01');
    expect(within(dialog).getByLabelText('Amount')).toHaveValue('1,650.00');
    expect(within(dialog).getByLabelText('From account')).toHaveValue(CHECKING);
    expect(within(dialog).getByText(/due Oct 1, 2026/)).toBeInTheDocument();
    expect(within(dialog).getByText('-1,650.00')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /creates a transaction in your register and removes the bill from the projection/,
      ),
    ).toBeInTheDocument();
  });

  it('posts what the user actually typed, with the schedule’s sign put back', async () => {
    const dialog = await open();

    fireEvent.change(within(dialog).getByLabelText('Paid on'), {
      target: { value: '2026-10-03' },
    });
    fireEvent.change(within(dialog).getByLabelText('Amount'), {
      target: { value: '1,712.45' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create transaction' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.url).toContain(`/api/v1/occurrences/${OCC_RENT}/pay`);
    expect(posted[0]?.body).toEqual({
      paidOn: '2026-10-03',
      amountMinor: '-171245',
      ledgerAccountId: CHECKING,
    });
  });

  it('closes and asks the API for the forecast again, which is what drops the bill', async () => {
    const dialog = await open();
    expect(asked).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Create transaction' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The occurrence leaves the projection because the API says so on the next
    // read, never because the page removed a row on its own.
    await waitFor(() => expect(asked).toEqual([ONE_MONTH, ONE_MONTH]));
    expect(within(dialog).queryByText('Harbor Apartments')).toBeNull();
  });

  it('keeps income positive when it is paid', async () => {
    const dialog = await open('Acme Corp Payroll');

    expect(within(dialog).getByLabelText('Amount')).toHaveValue('2,429.90');
    fireEvent.click(screen.getByRole('button', { name: 'Create transaction' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toMatchObject({ amountMinor: '242990', paidOn: '2026-09-25' });
  });

  it('refuses an amount of zero rather than posting it', async () => {
    const dialog = await open();

    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '0.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create transaction' }));

    expect(await within(dialog).findByText('Enter an amount above zero')).toBeInTheDocument();
    expect(posted).toHaveLength(0);
  });

  it('shows the server’s problem detail and stays open when paying fails', async () => {
    const dialog = await open();
    server.use(
      http.post('/api/v1/occurrences/:id/pay', () =>
        HttpResponse.json(
          {
            type: 'https://pfm.local/problems/occurrence-paid',
            title: 'Already paid',
            status: 409,
            detail: 'This bill was already marked paid.',
            materializedEntryId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create transaction' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This bill was already marked paid.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Dialog notes 1–3 — scheduling one.

describe('the New bill or income dialog', () => {
  const open = async () => {
    server.use(...handlers());
    renderPage();
    await seeRent();
    fireEvent.click(screen.getByRole('button', { name: /New bill or income/ }));
    return screen.findByRole('dialog');
  };

  const choose = async (dialog: HTMLElement, id: string, name: string) => {
    await within(dialog).findByRole('option', { name });
    fireEvent.change(within(dialog).getByLabelText('Category'), { target: { value: id } });
  };

  const tab = (dialog: HTMLElement, name: string) => {
    const trigger = within(dialog).getByRole('tab', { name });
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
  };

  const fill = (dialog: HTMLElement, categoryId: string) => {
    fireEvent.change(within(dialog).getByLabelText('Payee'), {
      target: { value: 'Harbor Apartments' },
    });
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '1,650.00' } });
    fireEvent.change(within(dialog).getByLabelText('First due'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(within(dialog).getByLabelText('Category'), {
      target: { value: categoryId },
    });
    // Picked explicitly, so these tests fail for their own subject rather than
    // for the prefill, which has a test of its own below.
    fireEvent.change(within(dialog).getByLabelText(/^(From|Into) account/), {
      target: { value: CHECKING },
    });
  };

  it('says plainly that nothing enters the ledger yet', async () => {
    const dialog = await open();

    expect(
      within(dialog).getByText(
        /Nothing is added to your ledger now\. This schedules it, and it appears in the projection until you mark it paid\./,
      ),
    ).toBeInTheDocument();
  });

  it('offers the four repeat rules and no fifth', async () => {
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('First due'), {
      target: { value: '2026-10-31' },
    });

    const repeats = within(dialog).getByLabelText(/^Repeats/) as HTMLSelectElement;
    expect([...repeats.options].map((option) => option.text)).toEqual([
      'One-off',
      'Weekly',
      'Every two weeks',
      'Monthly on the 31st',
    ]);
    expect([...repeats.options].map((option) => option.value)).toEqual([
      'one-off',
      'weekly',
      'biweekly',
      'monthly',
    ]);
    expect(
      within(dialog).getByText('One-off, weekly, every two weeks, or monthly on a day.'),
    ).toBeInTheDocument();
  });

  it('posts a bill as negative, with the anchor day taken from the first due date', async () => {
    const dialog = await open();
    await choose(dialog, RENT, 'Rent');
    fill(dialog, RENT);
    fireEvent.click(screen.getByRole('button', { name: 'Schedule it' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.url).toContain('/api/v1/recurring');
    expect(posted[0]?.body).toEqual({
      payee: 'Harbor Apartments',
      amountMinor: '-165000',
      ledgerAccountId: CHECKING,
      categoryId: RENT,
      rule: { frequency: 'monthly', dayOfMonth: 1 },
      firstDueOn: '2026-10-01',
      endsOn: null,
    });
  });

  it('follows the tab with the sign and with the category list', async () => {
    const dialog = await open();

    expect(within(dialog).getByLabelText('From account')).toBeInTheDocument();
    const billCategories = within(dialog).getByLabelText('Category') as HTMLSelectElement;
    await waitFor(() =>
      expect([...billCategories.options].map((o) => o.text)).toEqual([
        'Choose…',
        'Rent',
        'Utilities',
      ]),
    );

    tab(dialog, 'Income');

    const incomeCategories = within(dialog).getByLabelText('Category') as HTMLSelectElement;
    await waitFor(() =>
      expect([...incomeCategories.options].map((o) => o.text)).toEqual(['Choose…', 'Salary']),
    );
    expect(within(dialog).getByLabelText('Into account')).toBeInTheDocument();

    await choose(dialog, SALARY, 'Salary');
    fill(dialog, SALARY);
    fireEvent.change(within(dialog).getByLabelText('Payee'), {
      target: { value: 'Acme Corp Payroll' },
    });
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '2,429.90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule it' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toMatchObject({ amountMinor: '242990', categoryId: SALARY });
  });

  it('will not carry a category across the tab that changed the list', async () => {
    const dialog = await open();
    await choose(dialog, RENT, 'Rent');
    fill(dialog, RENT);

    tab(dialog, 'Income');
    fireEvent.click(screen.getByRole('button', { name: 'Schedule it' }));

    expect(await within(dialog).findByText('Choose a category')).toBeInTheDocument();
    expect(posted).toHaveLength(0);
  });

  it('prefills the account it is already showing, so it can be scheduled without re-picking it', async () => {
    const dialog = await open();
    const chosen = within(dialog).getByLabelText('From account') as HTMLSelectElement;

    // The mock-up shows "From account: Everyday Checking" already filled in,
    // and dialog note 1 has both tabs picking a real account.
    expect(chosen.value).toBe(CHECKING);
    expect(chosen.options[chosen.selectedIndex]?.text).toBe('Everyday Checking');

    await choose(dialog, RENT, 'Rent');
    fireEvent.change(within(dialog).getByLabelText('Payee'), { target: { value: 'Harbor' } });
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '1,650.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule it' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toMatchObject({ ledgerAccountId: CHECKING });
  });

  it('refuses an empty payee and an unparseable amount, posting nothing', async () => {
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: 'a lot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule it' }));

    expect(await within(dialog).findByText('Enter a payee')).toBeInTheDocument();
    expect(within(dialog).getByText('Use a format like 24.00')).toBeInTheDocument();
    expect(posted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The states board.

describe('empty and loading', () => {
  it('explains what scheduling buys, and offers the header’s action', async () => {
    server.use(...handlers(empty));
    renderPage();

    expect(await screen.findByText('Nothing scheduled yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Add a bill or a paycheque and the projection shows where your balance is heading.',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /New bill or income/ })).toHaveLength(2);
    expect(screen.queryByRole('table')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: /New bill or income/ })[1] as HTMLElement);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('keeps the chart’s and the list’s geometry while loading, and shimmers only in motion', async () => {
    server.use(...handlers('pending'));
    const { container } = renderPage();

    const busy = (await screen.findByText('Loading the projection')).closest(
      '[aria-busy="true"]',
    ) as HTMLElement;
    expect(busy).not.toBeNull();
    // A block the chart's height, then three list rows of three cells each.
    expect(busy.querySelector('[class*="h-[150px]"]')).not.toBeNull();
    expect(busy.querySelectorAll('[class*="grid-cols-"]')).toHaveLength(3);
    for (const placeholder of busy.querySelectorAll('[class*="animate-pulse"]')) {
      expect(placeholder.className).toContain('motion-safe:animate-pulse');
    }

    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByTestId('chart')).toBeNull();
  });

  it('offers a retry, and says what went wrong, when the projection fails', async () => {
    server.use(
      http.get('/api/v1/projection', () =>
        HttpResponse.json(
          {
            type: 'https://pfm.local/problems/validation',
            title: 'Request validation failed',
            status: 400,
            detail: 'to: must be within 12 months of today',
          },
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
      ...handlers(),
    );
    renderPage();

    expect(await screen.findByText('The projection didn’t load')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('must be within 12 months of today');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
