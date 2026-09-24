import { Fragment, useState } from 'react';
import { SPLIT_LABEL, type CategoryLine, type CategoryTotal } from '@pfm/contracts';
import { problemOf } from '../../lib/api.js';
import { formatMinorUnits } from '../../lib/money.js';
import { shareWidth } from '../../lib/share.js';
import { CorrectionBadges } from '../transactions/CorrectionBadges.jsx';
import { EntryBadge } from '../transactions/EntryBadge.jsx';
import { useCategoryLines } from './api.js';
import { formatDayShort } from './params.js';

type Period = { from: string; to: string };

type Props = {
  /** Names the period in the caption: a month on the report, a range on a project. */
  periodLabel: string;
  scope: 'month' | 'period';
  categories: CategoryTotal[];
  period: Period;
  /**
   * Enables the per-category drill-down. The project page leaves it out: the
   * drill-down lists a category's every line, not one project's.
   */
  monthHref?: (month: string) => string;
};

const ChevronIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="transition-transform motion-reduce:transition-none group-aria-expanded:rotate-90">
    <path d="m4.5 3 3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

export const CategoryTable = ({ periodLabel, scope, categories, period, monthHref }: Props) => {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const largest = categories.reduce((max, c) => (c.totalMinor > max ? c.totalMinor : max), 0n);

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <table className="w-full border-collapse">
      <caption className="sr-only">Spending by category, {periodLabel}</caption>
      <thead>
        <tr className="border-b border-slate-300">
          <th scope="col" className="px-2.5 pb-2 text-left text-xs font-semibold text-slate-500">
            Category
          </th>
          <th scope="col" className="w-[30%] px-2.5 pb-2">
            <span className="sr-only">Share</span>
          </th>
          <th scope="col" className="w-36 px-2.5 pb-2 text-right text-xs font-semibold text-slate-500">
            Amount, USD
          </th>
        </tr>
      </thead>
      <tbody>
        {categories.map((category) => {
          const isOpen = open.has(category.ledgerAccountId);
          const negative = category.totalMinor < 0n;
          return (
            <Fragment key={category.ledgerAccountId}>
              <tr className="border-b border-slate-100">
                <td className="px-2.5 py-2.5 text-sm">
                  {monthHref ? (
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => toggle(category.ledgerAccountId)}
                      className="group inline-flex items-center gap-2 font-semibold text-slate-800"
                    >
                      <ChevronIcon />
                      {category.name}
                    </button>
                  ) : (
                    <span className="font-semibold text-slate-800">{category.name}</span>
                  )}
                  {category.includesCorrection && (
                    <EntryBadge tone="correction">Includes a correction</EntryBadge>
                  )}
                  {negative && (
                    <p className="mt-1.5 rounded bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
                      Below zero because a correction this {scope} moved spending out of this category.
                    </p>
                  )}
                </td>
                <td className="px-2.5 py-2.5">
                  <div
                    aria-hidden="true"
                    className={`h-2 rounded ${negative ? 'bg-amber-700/50' : 'bg-emerald-700/75'}`}
                    style={{ width: shareWidth(category.totalMinor, largest) }}
                  />
                </td>
                <td className="px-2.5 py-2.5 text-right text-sm tabular-nums text-slate-900">
                  {formatMinorUnits(category.totalMinor)}
                </td>
              </tr>
              {isOpen && monthHref && (
                <CategoryLines
                  ledgerAccountId={category.ledgerAccountId}
                  period={period}
                  monthHref={monthHref}
                />
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
};

const CategoryLines = ({
  ledgerAccountId,
  period,
  monthHref,
}: {
  ledgerAccountId: string;
  period: Period;
  monthHref(month: string): string;
}) => {
  const lines = useCategoryLines(ledgerAccountId, period.from, period.to);

  if (lines.isPending) {
    return (
      <tr aria-busy="true">
        <td colSpan={3} className="bg-slate-50 py-2 pl-10 pr-2.5">
          <div className="h-3 w-1/2 rounded bg-slate-200 motion-safe:animate-pulse" />
          <span className="sr-only">Loading transactions</span>
        </td>
      </tr>
    );
  }

  if (lines.isError) {
    return (
      <tr>
        <td colSpan={3} className="bg-slate-50 py-2 pl-10 pr-2.5">
          <div role="alert" className="flex items-center justify-between gap-2 rounded bg-rose-50 px-2.5 py-1.5 text-xs text-rose-800">
            <span>Transactions didn’t load. {problemOf(lines.error)?.detail}</span>
            <button type="button" onClick={() => void lines.refetch()} className="font-semibold underline">
              Try again
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <>
      {lines.data.lines.map((line) => (
        <LineRow key={line.lineId} line={line} monthHref={monthHref} />
      ))}
    </>
  );
};

export const accountLabel = (line: Pick<CategoryLine, 'accounts'>): string | null => {
  if (line.accounts.length > 1) return SPLIT_LABEL;
  return line.accounts[0]?.name ?? null;
};

const LineRow = ({ line, monthHref }: { line: CategoryLine; monthHref(month: string): string }) => {
  const account = accountLabel(line);
  // Each badge links to the entry it names, in the month it is reported — the
  // month it was dated, not the month it was corrected.
  const linkTo = (occurredOn: string) => monthHref(occurredOn.slice(0, 7));

  return (
    <tr className="border-b border-slate-100 bg-slate-50/70">
      <td colSpan={2} className="py-2 pl-10 pr-2.5 text-sm">
        <span className="mr-3 tabular-nums text-slate-500">{formatDayShort(line.occurredOn)}</span>
        <span className="font-medium text-slate-800">{line.payee ?? '—'}</span>
        {account && <span className="ml-2.5 text-xs text-slate-500">{account}</span>}
        <CorrectionBadges
          reverses={line.reverses}
          reversedBy={line.reversedBy}
          replaces={line.replaces}
          linkTo={linkTo}
        />
      </td>
      <td className="px-2.5 py-2 text-right text-sm tabular-nums text-slate-800">
        {formatMinorUnits(line.amountMinor)}
      </td>
    </tr>
  );
};
