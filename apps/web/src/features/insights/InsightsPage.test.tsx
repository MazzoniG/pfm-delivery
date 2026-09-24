import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import type { LedgerAccount, SpendingReportWire } from '@pfm/contracts';
import { InsightsPage } from './InsightsPage.jsx';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const CHECKING = '11111111-1111-4111-8111-111111111111';

const accounts: LedgerAccount[] = [
  {
    id: CHECKING,
    name: 'Everyday Checking',
    kind: 'asset',
    currency: 'USD',
    isSystem: false,
    archivedAt: null,
    createdAt: '2026-04-01T09:00:00.000Z',
  },
];

const nameReport: SpendingReportWire = {
  from: '2026-09-01',
  to: '2026-09-30',
  totalMinor: '406160',
  grouping: 'name',
  fallback: null,
  groups: [
    { payee: 'Harbor Apartments', totalMinor: '165000', transactionCount: 1, categories: ['Rent'], isLargest: true },
    { payee: 'Maple Street Hardware', totalMinor: '41500', transactionCount: 2, categories: ['Home Improvement', 'Household'], isLargest: false },
  ],
};

const meaningReport: SpendingReportWire = {
  from: '2026-09-01',
  to: '2026-09-30',
  totalMinor: '406160',
  grouping: 'meaning',
  sent: { names: ['Harbor Apartments', 'Oakline Lumber'], at: '2026-09-22T10:42:00.000Z' },
  groups: [
    {
      label: 'Housing',
      origin: 'model',
      totalMinor: '165000',
      isLargest: true,
      payees: [{ payee: 'Harbor Apartments', totalMinor: '165000', transactionCount: 1, categories: ['Rent'] }],
    },
    {
      label: 'Home improvement',
      origin: 'model',
      totalMinor: '151640',
      isLargest: false,
      payees: [
        { payee: 'Oakline Lumber', totalMinor: '61240', transactionCount: 1, categories: ['Home Improvement'] },
        { payee: 'Tile & Stone Co', totalMinor: '48900', transactionCount: 1, categories: ['Home Improvement'] },
      ],
    },
    {
      label: 'Other',
      origin: 'other',
      totalMinor: '89520',
      isLargest: false,
      payees: [{ payee: 'The Bookshop', totalMinor: '89520', transactionCount: 2, categories: ['Gifts'] }],
    },
  ],
};

const base = (semanticAvailable: boolean, enabled: boolean, report: SpendingReportWire) => [
  http.get('/api/v1/accounts', () => HttpResponse.json(accounts)),
  http.get('/api/v1/accounts/balances', () =>
    HttpResponse.json({
      asOf: '2026-09-22',
      accounts: [{ ledgerAccountId: CHECKING, kind: 'asset', archived: false, balanceMinor: '581334' }],
      subtotals: { asset: '581334', liability: '0' },
      netWorthMinor: '581334',
    }),
  ),
  http.get('/api/v1/insights/settings', () => HttpResponse.json({ semanticAvailable, enabled })),
  http.put('/api/v1/insights/settings', () =>
    HttpResponse.json({ semanticAvailable, enabled: true }),
  ),
  http.post('/api/v1/insights/spending-report', () => HttpResponse.json(report)),
];

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/insights?period=2026-09']}>
        <Routes>
          <Route path="/insights" element={<InsightsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

it('generates on the button, marks the largest group and states the matching rule', async () => {
  server.use(...base(true, false, nameReport));
  renderPage();

  expect(screen.queryByText('Harbor Apartments')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /generate report/i }));

  expect(await screen.findByText('Harbor Apartments')).toBeInTheDocument();
  expect(screen.getByText('4,061.60')).toBeInTheDocument();
  expect(screen.getByText('Largest')).toBeInTheDocument();
  expect(screen.getByText(/AMAZON MKTP/)).toBeInTheDocument();
  expect(screen.getByText(/Home Improvement and Household, 2 transactions/)).toBeInTheDocument();
});

it('asks for consent before the switch turns on, then groups by meaning', async () => {
  server.use(...base(true, false, meaningReport));
  renderPage();

  await waitFor(() =>
    expect(screen.getByRole('switch', { name: 'Group by meaning' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('switch', { name: 'Group by meaning' }));

  expect(await screen.findByText(/This sends merchant names to Anthropic/)).toBeInTheDocument();
  expect(screen.getByText(/Amounts, dates, accounts, balances, or your name/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));

  await waitFor(() =>
    expect(screen.getByRole('switch', { name: 'Group by meaning' })).toHaveAttribute(
      'aria-checked',
      'true',
    ),
  );

  fireEvent.click(screen.getByRole('button', { name: /generate report/i }));
  expect(await screen.findByText('Home improvement')).toBeInTheDocument();
  expect(screen.getAllByTitle('Grouped by AI')).toHaveLength(2);
  expect(screen.getByText('Ungrouped')).toBeInTheDocument();

  // a one-payee group names its payee instead of expanding
  expect(screen.getByText('Harbor Apartments')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /home improvement/i }));
  expect(await screen.findByText('Tile & Stone Co')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /see exactly what was sent/i }));
  expect(await screen.findByText(/2 names, nothing else/)).toBeInTheDocument();
});

it('disables the switch and says why when the server has no key', async () => {
  server.use(...base(false, false, nameReport));
  renderPage();

  expect(
    await screen.findByText(/needs an API key, which this server does not have/),
  ).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Group by meaning' })).toBeDisabled();
  expect(screen.getByText('— unavailable')).toBeInTheDocument();
});

it('degrades to name matching, with one calm sentence, when the model fails', async () => {
  server.use(...base(true, true, { ...nameReport, grouping: 'name', fallback: 'provider-failed' }));
  renderPage();

  fireEvent.click(screen.getByRole('button', { name: /generate report/i }));
  expect(await screen.findByText(/didn’t work this time/)).toBeInTheDocument();
  expect(screen.getByText('Harbor Apartments')).toBeInTheDocument();
});

it('says so when the period is empty', async () => {
  server.use(...base(true, false, { ...nameReport, groups: [], totalMinor: '0' }));
  renderPage();

  fireEvent.click(screen.getByRole('button', { name: /generate report/i }));
  expect(await screen.findByText('No spending in this period')).toBeInTheDocument();
});
