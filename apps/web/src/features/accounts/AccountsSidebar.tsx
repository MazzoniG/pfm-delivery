import type { LedgerAccount } from '@pfm/contracts';
import { problemOf } from '../../lib/api.js';
import { AsOfPicker } from './AsOfPicker.jsx';
import { BalanceFigure } from './BalanceFigure.jsx';
import { useAccounts, useBalances } from './api.js';
import { useAsOf } from './asOf.js';

/** The UI word for a `kind`. "Banking" and "Credit" are what a person calls these. */
const groups = [
  { kind: 'asset' as const, label: 'Banking' },
  { kind: 'liability' as const, label: 'Credit' },
];

type Props = {
  selectedId: string | null;
  onSelect: (account: LedgerAccount) => void;
};

export const AccountsSidebar = ({ selectedId, onSelect }: Props) => {
  const { data, isPending, isError } = useAccounts();
  const asOf = useAsOf();
  const balances = useBalances(asOf.asOf);

  // Every figure below is read from the response by id. Nothing on this screen
  // is summed: the API owns the per-account, per-kind and net-worth levels,
  // which is also why archived accounts — hidden from the list, present in the
  // response — still count in the subtotals and in net worth.
  const byAccount = new Map(
    balances.data?.accounts.map((row) => [row.ledgerAccountId, row.balanceMinor]),
  );

  return (
    <nav aria-label="Accounts" className="w-72 shrink-0 border-r border-slate-200 bg-white">
      <div className="px-4 pb-3 pt-4">
        <p className="text-xs font-semibold text-slate-600">Net worth</p>
        <BalanceFigure
          value={balances.data?.netWorthMinor}
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

      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-4">
        <span className="text-xs text-slate-600">Balances as of</span>
        <AsOfPicker {...asOf} />
      </div>

      <hr className="mx-4 border-slate-200" />

      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Accounts</h2>
      </div>

      {isPending && (
        <div className="space-y-2 px-4" aria-busy="true">
          {[0, 1, 2].map((n) => (
            <div key={n} className="h-4 animate-pulse rounded bg-slate-100" />
          ))}
        </div>
      )}

      {isError && <p className="px-4 text-sm text-rose-700">Accounts didn’t load.</p>}

      {balances.isError && (
        <div
          role="alert"
          className="mx-2 mb-2 flex items-start justify-between gap-2 rounded bg-rose-50 px-2.5 py-2 text-xs text-rose-800"
        >
          <span>Balances didn’t load. {problemOf(balances.error)?.detail}</span>
          <button
            type="button"
            onClick={() => void balances.refetch()}
            className="shrink-0 font-semibold underline"
          >
            Try again
          </button>
        </div>
      )}

      {data &&
        groups.map(({ kind, label }) => {
          const accounts = data.filter((account) => account.kind === kind);
          if (accounts.length === 0) return null;

          return (
            <div key={kind} className="px-2 pb-3">
              <div className="flex items-baseline justify-between px-2 py-1">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {label}
                </h3>
                <BalanceFigure
                  value={balances.data?.subtotals[kind]}
                  pending={balances.isPending}
                  owed={kind === 'liability'}
                  className="text-xs tabular-nums text-slate-500"
                  owedClassName="ml-1 text-[11px] font-semibold text-slate-500"
                />
              </div>
              <ul>
                {accounts.map((account) => (
                  <li key={account.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(account)}
                      aria-current={account.id === selectedId ? 'true' : undefined}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                        account.id === selectedId
                          ? 'bg-emerald-50 font-semibold text-emerald-900'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className="truncate">{account.name}</span>
                      <BalanceFigure
                        value={byAccount.get(account.id)}
                        pending={balances.isPending}
                        owed={account.kind === 'liability'}
                        className="shrink-0 tabular-nums"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
    </nav>
  );
};
