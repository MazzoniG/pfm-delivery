import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { ScheduledOccurrenceView } from '@pfm/contracts';
import { NavRail } from '../../components/NavRail.jsx';
import { Button } from '../../components/ui/button.js';
import { problemOf } from '../../lib/api.js';
import { formatMinorUnits } from '../../lib/money.js';
import { AccountsSidebar } from '../accounts/AccountsSidebar.js';
import { useAccounts } from '../accounts/api.js';
import { BillsTable } from './BillsTable.jsx';
import { MarkPaidDialog } from './MarkPaidDialog.jsx';
import { NewBillDialog } from './NewBillDialog.jsx';
import { ProjectionChart } from './ProjectionChart.jsx';
import { useProjection } from './api.js';
import { PlusIcon, WarningIcon } from './icons.jsx';
import { HORIZONS, useBillsParams } from './params.js';

export const BillsPage = () => {
  const navigate = useNavigate();
  const params = useBillsParams();
  const projection = useProjection(params.to);
  const accounts = useAccounts();

  const [scheduling, setScheduling] = useState(false);
  const [paying, setPaying] = useState<ScheduledOccurrenceView | null>(null);

  // Archived accounts keep their money but take no new bills.
  const spendable = (accounts.data ?? []).filter((account) => account.archivedAt === null);
  const data = projection.data;
  const nothingScheduled =
    data !== undefined &&
    data.overdue.occurrences.length === 0 &&
    data.scheduled.occurrences.length === 0;

  return (
    <div className="flex min-h-screen bg-slate-50">
      <NavRail />
      <AccountsSidebar
        selectedId={null}
        onSelect={(account) => void navigate(`/transactions?account=${account.id}`)}
      />

      <main className="min-w-0 flex-1 px-6 py-5">
        <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Bills and income</h1>
            <p className="text-sm text-slate-500">Scheduled, not yet in the ledger</p>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2.5">
            <div
              role="group"
              aria-label="Horizon"
              className="inline-flex rounded-md bg-slate-100 p-[3px]"
            >
              {HORIZONS.map((months) => (
                <button
                  key={months}
                  type="button"
                  aria-pressed={params.months === months}
                  onClick={() => params.setMonths(months)}
                  className={`rounded px-3 py-1 text-[13.5px] font-semibold ${
                    params.months === months
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  {months} month{months === 1 ? '' : 's'}
                </button>
              ))}
            </div>

            <Button variant="primary" onClick={() => setScheduling(true)}>
              <PlusIcon />
              New bill or income
            </Button>
          </div>
        </header>

        {projection.isPending && (
          <div aria-busy="true">
            <div className="mb-5 rounded-lg border border-slate-200 bg-white px-4 pb-3 pt-4">
              <div className="h-[150px] rounded-lg bg-slate-100 motion-safe:animate-pulse" />
            </div>
            {[0, 1, 2].map((n) => (
              <div
                key={n}
                className="grid grid-cols-[2rem_1fr_5rem] gap-3.5 border-b border-slate-100 py-3.5"
              >
                <div className="h-3 rounded bg-slate-100 motion-safe:animate-pulse" />
                <div className="h-3 w-3/5 rounded bg-slate-100 motion-safe:animate-pulse" />
                <div className="h-3 rounded bg-slate-100 motion-safe:animate-pulse" />
              </div>
            ))}
            <span className="sr-only">Loading the projection</span>
          </div>
        )}

        {projection.isError && (
          <div className="flex min-h-52 flex-col items-start justify-center gap-2.5">
            <h2 className="text-base font-semibold text-slate-900">The projection didn’t load</h2>
            <p role="alert" className="w-full rounded bg-rose-50 px-2.5 py-2 text-sm text-rose-800">
              {problemOf(projection.error)?.detail ?? 'Something went wrong.'}
            </p>
            <Button onClick={() => void projection.refetch()}>Try again</Button>
          </div>
        )}

        {data && nothingScheduled && (
          <div className="flex min-h-52 flex-col items-start justify-center gap-2.5">
            <h2 className="text-lg font-semibold text-slate-900">Nothing scheduled yet</h2>
            <p className="max-w-md text-sm text-slate-500">
              Add a bill or a paycheque and the projection shows where your balance is heading.
            </p>
            <Button variant="primary" onClick={() => setScheduling(true)}>
              <PlusIcon />
              New bill or income
            </Button>
          </div>
        )}

        {data && !nothingScheduled && (
          <>
            <ProjectionChart projection={data} />

            {data.overdue.occurrences.length > 0 && (
              <section className="mt-4">
                <p className="mb-1 flex items-start gap-2.5 rounded-md bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800">
                  <WarningIcon />
                  <span>
                    <b className="font-semibold">
                      {data.overdue.occurrences.length === 1
                        ? 'One bill is past due'
                        : `${data.overdue.occurrences.length} bills are past due`}
                      , {formatMinorUnits(data.overdue.netMinor)} in total.
                    </b>{' '}
                    Past-due bills are not in the projection above, which starts from today’s
                    balance. Mark one paid, or change its date, to include it.
                  </span>
                </p>
                <BillsTable
                  occurrences={data.overdue.occurrences}
                  overdue
                  onPay={setPaying}
                  caption="Past due"
                />
              </section>
            )}

            <section className="mt-4">
              <h2 className="mb-2 flex items-baseline gap-2.5 text-xs font-semibold text-slate-600">
                Scheduled to {params.label}
                {/* The API's net, never a sum of the rows below it. */}
                <span className="tabular-nums font-semibold text-slate-500">
                  net {formatMinorUnits(data.scheduled.netMinor, { signDisplay: 'always' })}
                </span>
              </h2>
              {data.scheduled.occurrences.length === 0 ? (
                <p className="py-6 text-sm text-slate-500">
                  Nothing is scheduled between today and {params.label}.
                </p>
              ) : (
                <BillsTable
                  occurrences={data.scheduled.occurrences}
                  onPay={setPaying}
                  caption={`Scheduled to ${params.label}`}
                />
              )}
            </section>
          </>
        )}
      </main>

      {/*
        Mounted only once there is an account to default to, like the
        add-transaction dialog. The form captures its defaults on first render,
        so a dialog mounted while the accounts are still loading would open with
        nothing selected and refuse to submit until the user picked one by hand.
      */}
      {scheduling && spendable.length > 0 && (
        <NewBillDialog
          open={scheduling}
          onOpenChange={setScheduling}
          accounts={spendable}
          defaultAccountId={spendable[0]?.id ?? ''}
        />
      )}

      <MarkPaidDialog
        occurrence={paying}
        accounts={spendable}
        onOpenChange={(open) => !open && setPaying(null)}
      />
    </div>
  );
};
