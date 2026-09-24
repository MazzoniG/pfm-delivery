import { useState } from 'react';
import type { LedgerAccount, TransactionRowView } from '@pfm/contracts';
import { NavRail } from '../../components/NavRail.jsx';
import { Button } from '../../components/ui/button.js';
import { problemOf } from '../../lib/api.js';
import { AccountsSidebar } from '../accounts/AccountsSidebar.js';
import { BalanceFigure } from '../accounts/BalanceFigure.jsx';
import { useAccounts, useBalances } from '../accounts/api.js';
import { useAsOf } from '../accounts/asOf.js';
import { AddTransactionDialog } from './AddTransactionDialog.jsx';
import { EditTransactionDialog } from './EditTransactionDialog.jsx';
import { LockedEntryDialog } from './LockedEntryDialog.jsx';
import { RegisterTable } from './RegisterTable.jsx';
import { useProjects } from '../projects/api.js';
import { SplitEditor } from './SplitEditor.jsx';
import { useEntry, useTransactions } from './api.js';
import { RANGES, rangeToDates, useRegisterFilters, type Range } from './filters.js';
import { PlusIcon, SearchIcon } from './icons.jsx';

const kindLabel: Record<string, string> = {
  asset: 'Checking or savings account',
  liability: 'Credit account',
};

export const TransactionsPage = () => {
  const filters = useRegisterFilters();
  const accounts = useAccounts();

  const selected: LedgerAccount | undefined =
    accounts.data?.find((account) => account.id === filters.accountId) ?? accounts.data?.[0];

  const asOf = useAsOf();
  // Same query key as the sidebar's, so the header figure comes out of the one
  // batch response and switching accounts fires no second balance request.
  const balances = useBalances(asOf.asOf);
  const balance = balances.data?.accounts.find(
    (row) => row.ledgerAccountId === selected?.id,
  )?.balanceMinor;

  const { from, to } = rangeToDates(filters.range);
  const register = useTransactions(
    selected
      ? {
          accountId: selected.id,
          projectId: filters.projectId ?? undefined,
          from,
          to,
          q: filters.q || undefined,
        }
      : null,
  );

  const projects = useProjects();
  // A link can carry an id this owner cannot name — deleted, mistyped, or
  // someone else's. The API answers it with an empty page; the chip says so.
  const projectName = filters.projectId
    ? projects.isPending
      ? 'Loading…'
      : (projects.data?.find((project) => project.id === filters.projectId)?.name ?? 'Unknown project')
    : null;
  const elsewhere = register.data?.pages[0]?.projectEntriesInOtherAccounts ?? 0;

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [splitId, setSplitId] = useState<string | null>(null);
  const [lockedAt, setLockedAt] = useState<string | null>(null);

  const editing = useEntry(editingId);
  const rows = register.data?.pages.flatMap((page) => page.data) ?? [];

  // A split opens the split editor, never the two-line edit dialog, which
  // would silently flatten it.
  const openRow = (row: TransactionRowView) => {
    if (row.counterparty.kind === 'split') setSplitId(row.entryId);
    else setEditingId(row.entryId);
  };

  const closeEditing = () => {
    setEditingId(null);
    setLockedAt(null);
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <NavRail />
      <AccountsSidebar
        selectedId={selected?.id ?? null}
        onSelect={(account) => filters.setAccount(account.id)}
      />

      <main className="flex-1 px-6 py-5">
        {asOf.isPast && (
          <div
            role="status"
            className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-900"
          >
            <p>
              Showing balances as of <b className="font-semibold">{asOf.label}</b>.
              Transactions below are not filtered by this date.
            </p>
            <Button onClick={asOf.backToToday}>Back to today</Button>
          </div>
        )}

        <header className="mb-4 flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">
              {selected?.name ?? 'Transactions'}
            </h1>
            <p className="text-sm text-slate-500">
              {selected ? kindLabel[selected.kind] : ''}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="min-w-[9rem] text-right">
              <p className="text-xs font-semibold text-slate-500">
                {selected?.kind === 'liability' ? 'Balance owed' : 'Balance'}
              </p>
              <BalanceFigure
                value={balance}
                pending={balances.isPending}
                className="block text-2xl font-semibold tabular-nums text-slate-900"
                barClassName="h-6 w-28"
              />
              <p
                className={`text-xs ${
                  asOf.isPast ? 'font-semibold text-emerald-700' : 'text-slate-500'
                }`}
              >
                {asOf.whenLabel}
              </p>
            </div>
            <Button variant="primary" onClick={() => setAdding(true)} disabled={!selected}>
              <PlusIcon />
              Add transaction
            </Button>
          </div>
        </header>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <select
            aria-label="Date range"
            value={filters.range}
            onChange={(event) => filters.setRange(event.target.value as Range)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
          >
            {Object.entries(RANGES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-2 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-500">
            <SearchIcon />
            <input
              aria-label="Search payee"
              placeholder="Search payee"
              defaultValue={filters.q}
              onChange={(event) => filters.setQuery(event.target.value.trim())}
              className="w-44 focus:outline-none"
            />
          </div>

          {projectName !== null && (
            <span className="inline-flex items-center gap-2 rounded-md bg-emerald-50 py-1 pl-3 pr-1.5 text-sm font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-200">
              Project: {projectName}
              <button
                type="button"
                aria-label="Clear project filter"
                onClick={filters.clearProject}
                className="rounded p-1 hover:bg-emerald-100"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="m2 2 8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          )}
        </div>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          {register.isPending && (
            <div className="space-y-3" aria-busy="true">
              {[0, 1, 2, 3].map((n) => (
                <div key={n} className="flex gap-4">
                  <div className="h-4 w-10 animate-pulse rounded bg-slate-100" />
                  <div className="h-4 flex-1 animate-pulse rounded bg-slate-100" />
                  <div className="h-4 w-24 animate-pulse rounded bg-slate-100" />
                </div>
              ))}
            </div>
          )}

          {register.isError && (
            <div className="py-10 text-center">
              <h2 className="text-sm font-semibold text-slate-900">
                Transactions didn’t load
              </h2>
              <p
                role="alert"
                className="mx-auto mt-2 max-w-md rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
              >
                {problemOf(register.error)?.detail ?? 'Something went wrong.'}
              </p>
              <Button className="mt-3" onClick={() => void register.refetch()}>
                Try again
              </Button>
            </div>
          )}

          {register.isSuccess && rows.length === 0 && projectName !== null && (
            <div className="py-10 text-center">
              <h2 className="text-sm font-semibold text-slate-900">
                No transactions for this project in this account
              </h2>
            </div>
          )}

          {register.isSuccess && rows.length === 0 && projectName === null && (
            <div className="py-10 text-center">
              <h2 className="text-sm font-semibold text-slate-900">No transactions yet</h2>
              <p className="mt-1 text-sm text-slate-500">
                Add the first one to start this account’s register.
              </p>
              <Button variant="primary" className="mt-3" onClick={() => setAdding(true)}>
                Add transaction
              </Button>
            </div>
          )}

          {rows.length > 0 && (
            <>
              <RegisterTable rows={rows} onOpenSplit={setSplitId} onOpenEntry={openRow} />
              {register.hasNextPage && (
                <div className="mt-4 text-center">
                  <Button
                    onClick={() => void register.fetchNextPage()}
                    disabled={register.isFetchingNextPage}
                  >
                    {register.isFetchingNextPage ? 'Loading…' : 'Load older transactions'}
                  </Button>
                </div>
              )}
            </>
          )}

          {projectName !== null && elsewhere > 0 && (
            <p className="mt-2.5 text-xs text-slate-500">
              Showing this account only. In the selected period, {elsewhere} more {projectName}{' '}
              transaction{elsewhere === 1 ? ' was' : 's were'} paid from other accounts.
            </p>
          )}
        </section>
      </main>

      {adding && selected && accounts.data && (
        <AddTransactionDialog
          open={adding}
          onOpenChange={setAdding}
          accounts={accounts.data}
          defaultAccountId={selected.id}
        />
      )}

      {editingId && selected && editing.data && !lockedAt && (
        <EditTransactionDialog
          entry={editing.data}
          account={selected}
          onClose={closeEditing}
          onLocked={setLockedAt}
        />
      )}

      {editingId && selected && editing.data && lockedAt && (
        <LockedEntryDialog
          entry={editing.data}
          account={selected}
          lockedAt={lockedAt}
          onClose={closeEditing}
        />
      )}

      {splitId && selected && (
        <SplitEditor entryId={splitId} accountId={selected.id} onClose={() => setSplitId(null)} />
      )}
    </div>
  );
};
