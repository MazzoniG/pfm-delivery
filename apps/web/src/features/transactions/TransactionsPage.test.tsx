import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import type {
  BalancesResponseWire,
  LedgerAccount,
  TransactionPageWire,
} from '@pfm/contracts';
import { TransactionsPage } from './TransactionsPage.jsx';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const CHECKING = '11111111-1111-4111-8111-111111111111';
const VISA = '22222222-2222-4222-8222-222222222222';
const GROCERIES = '33333333-3333-4333-8333-333333333333';

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
  {
    id: VISA,
    name: 'Visa Credit Card',
    kind: 'liability',
    currency: 'USD',
    isSystem: false,
    archivedAt: null,
    createdAt: '2026-04-01T09:00:00.000Z',
  },
];

const row = (over: Partial<TransactionPageWire['data'][number]>): TransactionPageWire['data'][number] => ({
  entryId: '44444444-4444-4444-8444-444444444444',
  lineId: '55555555-5555-4555-8555-555555555555',
  occurredOn: '2026-09-19',
  payee: 'Corner Market',
  description: null,
  amountMinor: '-5420',
  lockedAt: null,
  reconciledAt: null,
  counterparty: {
    kind: 'single',
    ledgerAccountId: GROCERIES,
    name: 'Groceries',
    ledgerAccountKind: 'expense',
    projectId: null,
    excludedFromReporting: false,
  },
  reverses: null,
  reversedBy: null,
  replaces: null,
  ...over,
});

const page: TransactionPageWire = {
  data: [
    row({}),
    row({
      entryId: '66666666-6666-4666-8666-666666666666',
      lineId: '77777777-7777-4777-8777-777777777777',
      occurredOn: '2026-09-18',
      payee: 'Maple Street Hardware',
      amountMinor: '-23000',
      counterparty: { kind: 'split' },
    }),
    row({
      entryId: '88888888-8888-4888-8888-888888888888',
      lineId: '99999999-9999-4999-8999-999999999999',
      occurredOn: '2026-08-14',
      payee: 'Acme Corp Payroll',
      amountMinor: '242990',
      lockedAt: '2026-09-19T10:00:00.000Z',
      counterparty: {
        kind: 'single',
        ledgerAccountId: GROCERIES,
        name: 'Salary',
        ledgerAccountKind: 'income',
        projectId: null,
        excludedFromReporting: false,
      },
    }),
  ],
  nextCursor: '2026-08-14:88888888-8888-4888-8888-888888888888',
};

const balances: BalancesResponseWire = {
  asOf: '2026-09-21',
  accounts: [
    { ledgerAccountId: CHECKING, kind: 'asset', archived: false, balanceMinor: '485000' },
    { ledgerAccountId: VISA, kind: 'liability', archived: false, balanceMinor: '80000' },
  ],
  subtotals: { asset: '485000', liability: '80000' },
  netWorthMinor: '405000',
};

const renderPage = () => {
  server.use(
    http.get('*/api/v1/accounts/balances', () => HttpResponse.json(balances)),
    http.get('*/api/v1/accounts', () => HttpResponse.json(accounts)),
    http.get('*/api/v1/entries', () => HttpResponse.json(page)),
  );

  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[`/transactions?account=${CHECKING}`]}>
        <TransactionsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('register', () => {
  it('groups accounts by kind and selects the one in the URL', async () => {
    renderPage();

    const selected = await screen.findByRole('button', { name: /Everyday Checking/ });
    const sidebar = screen.getByRole('navigation', { name: 'Accounts' });

    expect(selected).toHaveAttribute('aria-current', 'true');
    expect(within(sidebar).getByText('Banking')).toBeInTheDocument();
    expect(within(sidebar).getByText('Credit')).toBeInTheDocument();
  });

  it('renders amounts in US format with an explicit sign, as returned', async () => {
    renderPage();

    expect(await screen.findByText('-54.20')).toBeInTheDocument();
    expect(screen.getByText('+2,429.90')).toBeInTheDocument();
    expect(screen.getByText('-230.00')).toBeInTheDocument();
  });

  it('collapses a multi-line counter-side to a split control', async () => {
    renderPage();

    expect(await screen.findByRole('button', { name: /Split/ })).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });

  it('groups rows by month and marks a reconciled row', async () => {
    renderPage();

    expect(await screen.findByText('September 2026')).toBeInTheDocument();
    expect(screen.getByText('August 2026')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Reconciled' })).toBeInTheDocument();
  });

  it('offers the next page from the cursor the server returned', async () => {
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Load older transactions' }),
    ).toBeInTheDocument();
  });
});
