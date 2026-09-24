import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import type {
  BalancesResponseWire,
  LedgerAccount,
  ProjectListWire,
  ProjectReportWire,
  TransactionPageWire,
} from '@pfm/contracts';
import { ProjectPage } from './ProjectPage.jsx';
import { ProjectsPage } from './ProjectsPage.jsx';
import { TransactionsPage } from '../transactions/TransactionsPage.jsx';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const CHECKING = '11111111-1111-4111-8111-111111111111';
const VISA = '22222222-2222-4222-8222-222222222222';
const HOME = '33333333-3333-4333-8333-333333333333';
const HOUSEHOLD = '44444444-4444-4444-8444-444444444444';
const REMODEL = '55555555-5555-4555-8555-555555555555';
const FRANCE = '66666666-6666-4666-8666-666666666666';
const SPLIT_ENTRY = '77777777-7777-4777-8777-777777777777';
const PROBLEM = { headers: { 'content-type': 'application/problem+json' } };

const account = (id: string, name: string, kind: LedgerAccount['kind']): LedgerAccount => ({
  id,
  name,
  kind,
  currency: 'USD',
  isSystem: false,
  archivedAt: null,
  createdAt: '2026-04-01T09:00:00.000Z',
});

const accounts = [account(CHECKING, 'Everyday Checking', 'asset'), account(VISA, 'Visa Credit Card', 'liability')];

const balances: BalancesResponseWire = {
  asOf: '2026-09-22',
  accounts: [
    { ledgerAccountId: CHECKING, kind: 'asset', archived: false, balanceMinor: '581334' },
    { ledgerAccountId: VISA, kind: 'liability', archived: false, balanceMinor: '37384' },
  ],
  subtotals: { asset: '581334', liability: '37384' },
  netWorthMinor: '543950',
};

const remodel = {
  id: REMODEL,
  name: 'House remodel',
  createdAt: '2026-07-01T09:00:00.000Z',
  netCostMinor: '148640',
  transactionCount: 4,
  firstActivityOn: '2026-07-29',
  lastActivityOn: '2026-09-19',
};

const projects: ProjectListWire = [
  remodel,
  {
    id: FRANCE,
    name: 'France trip',
    createdAt: '2026-05-01T09:00:00.000Z',
    netCostMinor: '231850',
    transactionCount: 12,
    firstActivityOn: '2026-05-03',
    lastActivityOn: '2026-06-28',
  },
];

const month = (m: string, totalMinor: string) => ({ month: m, totalMinor, categories: [] });

const report: ProjectReportWire = {
  project: remodel,
  from: '2026-04-01',
  to: '2026-09-30',
  months: [
    month('2026-04', '0'),
    month('2026-05', '0'),
    month('2026-06', '0'),
    month('2026-07', '18500'),
    month('2026-08', '110140'),
    month('2026-09', '20000'),
  ],
  categories: [
    { ledgerAccountId: HOME, name: 'Home Improvement', totalMinor: '130140', includesCorrection: true },
    { ledgerAccountId: HOUSEHOLD, name: 'Household', totalMinor: '18500', includesCorrection: false },
  ],
  lines: [
    {
      entryId: SPLIT_ENTRY,
      lineId: '88888888-8888-4888-8888-888888888881',
      occurredOn: '2026-09-19',
      payee: 'Maple Street Hardware',
      ledgerAccountId: HOME,
      categoryName: 'Home Improvement',
      accounts: [{ ledgerAccountId: CHECKING, name: 'Everyday Checking' }],
      amountMinor: '20000',
      entryTotalMinor: '23000',
      reverses: null,
      reversedBy: null,
      replaces: null,
    },
    {
      entryId: '99999999-9999-4999-8999-999999999991',
      lineId: '88888888-8888-4888-8888-888888888882',
      occurredOn: '2026-09-02',
      payee: 'Oakline Lumber',
      ledgerAccountId: HOME,
      categoryName: 'Home Improvement',
      accounts: [{ ledgerAccountId: VISA, name: 'Visa Credit Card' }],
      amountMinor: '-61240',
      entryTotalMinor: null,
      reverses: { id: '99999999-9999-4999-8999-999999999992', occurredOn: '2026-08-09' },
      reversedBy: null,
      replaces: null,
    },
  ],
  linesTruncated: false,
};

const row = (over: Partial<TransactionPageWire['data'][number]>): TransactionPageWire['data'][number] => ({
  entryId: SPLIT_ENTRY,
  lineId: '12121212-1212-4121-8121-121212121212',
  occurredOn: '2026-09-19',
  payee: 'Maple Street Hardware',
  description: null,
  amountMinor: '-23000',
  lockedAt: null,
  reconciledAt: null,
  counterparty: { kind: 'split' },
  reverses: null,
  reversedBy: null,
  replaces: null,
  projectShareMinor: '20000',
  ...over,
});

const filteredPage: TransactionPageWire = {
  data: [
    row({}),
    row({
      entryId: '13131313-1313-4131-8131-131313131313',
      lineId: '14141414-1414-4141-8141-141414141414',
      occurredOn: '2026-08-24',
      payee: 'Tile & Stone Co',
      amountMinor: '-48900',
      counterparty: {
        kind: 'single',
        ledgerAccountId: HOME,
        name: 'Home Improvement',
        ledgerAccountKind: 'expense',
        projectId: REMODEL,
        excludedFromReporting: false,
      },
      projectShareMinor: '48900',
    }),
  ],
  nextCursor: null,
  projectEntriesInOtherAccounts: 2,
};

const Location = () => {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
};

const renderAt = (url: string, extra: Parameters<typeof server.use> = []) => {
  const requests: URL[] = [];
  server.use(
    ...extra,
    http.get('*/api/v1/accounts/balances', () => HttpResponse.json(balances)),
    http.get('*/api/v1/accounts', () => HttpResponse.json(accounts)),
    http.get('*/api/v1/projects', () => HttpResponse.json(projects)),
    http.get('*/api/v1/reports/projects/:id', ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json(report);
    }),
    http.get('*/api/v1/entries', ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json(filteredPage);
    }),
  );

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
        </Routes>
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return requests;
};

describe('projects list', () => {
  it('is the current rail item and lists each project with the API’s figures', async () => {
    renderAt('/projects');

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');

    const table = await screen.findByRole('table', { name: 'Projects' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('link').textContent)).toEqual(['House remodel', 'France trip']);
    expect(within(rows[0]!).getByText('1,486.40')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('4 transactions, Jul to Sep 2026')).toBeInTheDocument();
  });

  it('explains what a project is for when there are none', async () => {
    renderAt('/projects', [http.get('*/api/v1/projects', () => HttpResponse.json([]))]);

    expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New project' })).toHaveLength(2);
  });
});

describe('project page', () => {
  it('reuses the report chart and category table over six months, the table covering the whole period', async () => {
    const requests = renderAt(`/projects/${REMODEL}`);

    expect(await screen.findByRole('heading', { name: 'House remodel' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Project spending per month' })).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Spending by category, House remodel, Apr to Sep 2026' }),
    ).toBeInTheDocument();
    // No drill-down: it would list every line of the category, not this project's.
    expect(screen.getByText('Home Improvement', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Home Improvement' })).not.toBeInTheDocument();

    const sent = requests.find((u) => u.pathname.endsWith(`/reports/projects/${REMODEL}`));
    expect(sent?.searchParams.get('from')?.endsWith('-01')).toBe(true);
  });

  it('shows a split line’s share over its entry total, and a reversal as a correction', async () => {
    renderAt(`/projects/${REMODEL}`);

    const lines = await screen.findByRole('table', { name: /Transactions in House remodel/ });
    const [split, reversal] = within(lines).getAllByRole('row');

    expect(within(split!).getByText('200.00')).toBeInTheDocument();
    expect(within(split!).getByText('of 230.00')).toBeInTheDocument();
    expect(within(split!).getByRole('button', { name: /Split/ })).toBeInTheDocument();

    expect(within(reversal!).getByText('-612.40')).toBeInTheDocument();
    expect(within(reversal!).getByText('Reversal of Aug 09')).toBeInTheDocument();
  });

  it('opens the register filtered to the project', async () => {
    renderAt(`/projects/${REMODEL}`);

    fireEvent.click(await screen.findByRole('link', { name: 'Show in register' }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        `/transactions?account=${CHECKING}&project=${REMODEL}`,
      ),
    );
  });

  it('renders the 409 detail when a project in use is deleted, with a way to its transactions', async () => {
    renderAt(`/projects/${REMODEL}`, [
      http.delete('*/api/v1/projects/:id', () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Project in use',
            status: 409,
            detail: '4 transactions are assigned to this project. Remove it from them first.',
            transactionCount: 4,
          },
          { status: 409, ...PROBLEM },
        ),
      ),
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }));

    const dialog = await screen.findByRole('dialog', { name: 'House remodel can’t be deleted' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('4 transactions are assigned to this project.');
    expect(within(dialog).getByRole('button', { name: 'Show its transactions' })).toBeInTheDocument();
  });

  it('surfaces the API’s detail when the project is not this owner’s', async () => {
    renderAt(`/projects/${REMODEL}`, [
      http.get('*/api/v1/reports/projects/:id', () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such project.' },
          { status: 404, ...PROBLEM },
        ),
      ),
    ]);

    expect(await screen.findByRole('alert')).toHaveTextContent('No such project.');
  });
});

describe('register filtered by project', () => {
  it('sends the project to the API and names it in a removable chip', async () => {
    const requests = renderAt(`/transactions?account=${CHECKING}&project=${REMODEL}`);

    expect(await screen.findByText('Project: House remodel')).toBeInTheDocument();
    const entries = requests.find((u) => u.pathname.endsWith('/entries'));
    expect(entries?.searchParams.get('projectId')).toBe(REMODEL);

    fireEvent.click(screen.getByRole('button', { name: 'Clear project filter' }));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(`/transactions?account=${CHECKING}`),
    );
    expect(screen.getByTestId('location').textContent).not.toContain('project=');
  });

  it('keeps a project id it cannot name clearable', async () => {
    renderAt(`/transactions?account=${CHECKING}&project=${crypto.randomUUID()}`);

    expect(await screen.findByText('Project: Unknown project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear project filter' })).toBeInTheDocument();
  });

  it('shows the API’s project share on a split row, beside the account-side amount', async () => {
    renderAt(`/transactions?account=${CHECKING}&project=${REMODEL}`);

    const share = await screen.findByText('200.00 to this project');
    const splitRow = share.closest('tr')!;
    expect(within(splitRow).getByText('-230.00')).toBeInTheDocument();
    // An unsplit row's share is the whole amount, so it carries no note.
    const tileRow = screen.getByText('Tile & Stone Co').closest('tr')!;
    expect(within(tileRow).queryByText(/to this project/)).not.toBeInTheDocument();
  });

  it('says the other-accounts count covers the selected period', async () => {
    renderAt(`/transactions?account=${CHECKING}&project=${REMODEL}`);

    expect(
      await screen.findByText(
        'Showing this account only. In the selected period, 2 more House remodel transactions were paid from other accounts.',
      ),
    ).toBeInTheDocument();
  });
});

describe('add transaction', () => {
  const openDialog = async (sent: unknown[]) => {
    renderAt(`/transactions?account=${CHECKING}`, [
      http.get('*/api/v1/categories', () =>
        HttpResponse.json([
          { id: HOME, name: 'Home Improvement', kind: 'expense', isSystem: false, archivedAt: null, createdAt: '2026-04-01T09:00:00.000Z' },
        ]),
      ),
      http.post('*/api/v1/entries', async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({}, { status: 500 });
      }),
    ]);
    const add = await screen.findByRole('button', { name: 'Add transaction' });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    return screen.findByRole('dialog', { name: 'Add transaction' });
  };

  it('offers an optional project on Money out and Money in, never on Transfer', async () => {
    const dialog = await openDialog([]);

    expect(within(dialog).getByRole('combobox', { name: 'Project (optional)' })).toBeInTheDocument();
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: 'Money in' }));
    expect(within(dialog).getByRole('combobox', { name: 'Project (optional)' })).toBeInTheDocument();
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: 'Transfer' }));
    expect(within(dialog).queryByRole('combobox', { name: 'Project (optional)' })).not.toBeInTheDocument();
  });

  it('sends the chosen project on the simple form', async () => {
    const sent: unknown[] = [];
    const dialog = await openDialog(sent);

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Amount' }), { target: { value: '24.00' } });
    const category = within(dialog).getByRole('combobox', { name: 'Category' });
    await within(category).findByRole('option', { name: 'Home Improvement' });
    fireEvent.change(category, { target: { value: HOME } });
    const project = within(dialog).getByRole('combobox', { name: 'Project (optional)' });
    await within(project).findByRole('option', { name: 'House remodel' });
    fireEvent.change(project, { target: { value: REMODEL } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add transaction' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ categoryId: HOME, amountMinor: '-2400', projectId: REMODEL });
  });
});
