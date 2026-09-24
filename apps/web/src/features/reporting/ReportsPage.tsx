import { useNavigate } from 'react-router';
import { NavRail } from '../../components/NavRail.jsx';
import { Button } from '../../components/ui/button.js';
import { problemOf } from '../../lib/api.js';
import { formatMinorUnits } from '../../lib/money.js';
import { AccountsSidebar } from '../accounts/AccountsSidebar.js';
import { CategoryTable } from './CategoryTable.jsx';
import { MonthlySpendingChart, MonthlySpendingChartSkeleton } from './MonthlySpendingChart.jsx';
import { useCategoryReport } from './api.js';
import {
  RANGES,
  formatMonthLong,
  formatMonthShort,
  monthEnd,
  monthStart,
  monthsBetween,
  useReportParams,
  type Range,
} from './params.js';

const later = (a: string, b: string): string => (a > b ? a : b);
const earlier = (a: string, b: string): string => (a < b ? a : b);

export const ReportsPage = () => {
  const navigate = useNavigate();
  const params = useReportParams();
  const report = useCategoryReport(params.from, params.to);

  const months = report.data?.months ?? [];
  const selected =
    months.find((m) => m.month === params.month) ?? months[months.length - 1] ?? null;

  const currentMonth = params.today.slice(0, 7);
  const partialMonth = params.today < monthEnd(currentMonth) ? currentMonth : null;
  const isPartial = selected !== null && selected.month === partialMonth;

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
            <h1 className="text-lg font-semibold text-slate-900">Spending by category</h1>
            <p className="text-sm text-slate-500">All accounts</p>
          </div>
          <select
            aria-label="Date range"
            value={params.range ?? 'custom'}
            onChange={(event) => params.setRange(event.target.value as Range)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
          >
            {params.range === null && (
              <option value="custom" disabled>
                {params.from} to {params.to}
              </option>
            )}
            {Object.entries(RANGES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </header>

        {report.isPending && (
          <>
            <MonthlySpendingChartSkeleton
              labels={monthsBetween(params.from, params.to).map(formatMonthShort)}
            />
            <div aria-busy="true" className="space-y-3">
              {[0, 1, 2].map((n) => (
                <div key={n} className="grid grid-cols-[2rem_1fr_4.5rem] gap-3.5 border-b border-slate-100 py-3">
                  <div className="h-3 rounded bg-slate-100 motion-safe:animate-pulse" />
                  <div className="h-3 w-3/5 rounded bg-slate-100 motion-safe:animate-pulse" />
                  <div className="h-3 rounded bg-slate-100 motion-safe:animate-pulse" />
                </div>
              ))}
              <span className="sr-only">Loading the report</span>
            </div>
          </>
        )}

        {report.isError && (
          <div className="flex min-h-52 flex-col items-start justify-center gap-2.5">
            <h2 className="text-base font-semibold text-slate-900">The report didn’t load</h2>
            <p role="alert" className="w-full rounded bg-rose-50 px-2.5 py-2 text-sm text-rose-800">
              {problemOf(report.error)?.detail ?? 'Something went wrong.'}
            </p>
            <Button onClick={() => void report.refetch()}>Try again</Button>
          </div>
        )}

        {report.isSuccess && selected && (
          <>
            <MonthlySpendingChart
              months={months}
              selected={selected.month}
              partialMonth={partialMonth}
              onSelect={params.selectMonth}
            />

            <div className="mb-2 flex items-end justify-between gap-3">
              <h2 className="text-base font-semibold text-slate-900">
                {formatMonthLong(selected.month)}
                {isPartial && (
                  <span className="ml-2 text-xs font-medium text-slate-500">
                    1 to {Number(params.today.slice(8, 10))}, to date
                  </span>
                )}
              </h2>
              <div className="text-right">
                <p className="text-xs font-semibold text-slate-500">Total spent</p>
                {/* The API's month total, never a sum of the rows below. */}
                <p className="text-2xl font-semibold tabular-nums text-slate-900">
                  {formatMinorUnits(selected.totalMinor)}
                </p>
              </div>
            </div>

            {selected.categories.length === 0 ? (
              <div className="py-8">
                <h3 className="text-base font-semibold text-slate-900">
                  No spending in {formatMonthLong(selected.month)}
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Nothing was spent this month, or everything was excluded from reports.
                </p>
              </div>
            ) : (
              <CategoryTable
                key={selected.month}
                periodLabel={formatMonthLong(selected.month)}
                scope="month"
                categories={selected.categories}
                period={{
                  from: later(monthStart(selected.month), params.from),
                  to: earlier(monthEnd(selected.month), params.to),
                }}
                monthHref={params.monthHref}
              />
            )}

            <p className="mt-3 text-xs text-slate-500">
              Transactions marked as excluded from reports are not counted.
            </p>
          </>
        )}
      </main>
    </div>
  );
};
