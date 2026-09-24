import { Fragment, useState } from 'react';
import type { MeaningGroup, NameGroup, SpendingReport } from '@pfm/contracts';
import { formatMinorUnits } from '../../lib/money.js';
import { shareWidth } from '../../lib/share.js';
import { SparkIcon } from './icons.jsx';

const LargestTag = () => (
  <span className="ml-2 rounded-full bg-emerald-700 px-2 py-0.5 text-[11px] font-bold text-white">
    Largest
  </span>
);

const Amount = ({ minor }: { minor: bigint }) => (
  <td className="w-36 border-l-[3px] border-double border-rose-200 px-2.5 py-3 text-right text-base tabular-nums">
    {formatMinorUnits(minor)}
  </td>
);

const Head = () => (
  <thead>
    <tr className="border-b border-slate-300">
      <th scope="col" className="px-2.5 pb-2 text-left text-xs font-semibold text-slate-500">
        Group
      </th>
      <th scope="col" className="w-[26%] px-2.5 pb-2">
        <span className="sr-only">Share</span>
      </th>
      <th scope="col" className="w-36 px-2.5 pb-2 text-right text-xs font-semibold text-slate-500">
        Amount, USD
      </th>
    </tr>
  </thead>
);

const ChevronIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    aria-hidden="true"
    className="transition-transform motion-reduce:transition-none group-aria-expanded:rotate-90"
  >
    <path d="m4.5 3 3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

const byName = (groups: NameGroup[], largest: bigint) => (
  <tbody>
    {groups.map((group) => (
      <tr
        key={group.payee}
        className={`border-b border-slate-100 ${group.isLargest ? 'bg-emerald-50/60' : ''}`}
      >
        <td className="px-2.5 py-3">
          <span className={`font-semibold ${group.isLargest ? 'text-emerald-800' : ''}`}>
            {group.payee}
          </span>
          {group.isLargest && <LargestTag />}
          <p className="mt-0.5 text-xs text-slate-500">
            {group.categories.join(' and ')}, {group.transactionCount}{' '}
            {group.transactionCount === 1 ? 'transaction' : 'transactions'}
          </p>
        </td>
        <td className="px-2.5 py-3">
          <div
            className="h-2 rounded bg-emerald-700/75"
            style={{ width: shareWidth(group.totalMinor, largest) }}
          />
        </td>
        <Amount minor={group.totalMinor} />
      </tr>
    ))}
  </tbody>
);

/**
 * A group of two or more payees expands to show them, each with its own figure.
 * A group of one names its payee underneath instead — expanding it would repeat
 * the number on the same row. A grouping nobody can inspect is one nobody
 * should trust, which is what the expansion is for.
 */
const ByMeaning = ({ groups, largest }: { groups: MeaningGroup[]; largest: bigint }) => {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const toggle = (label: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  return (
    <tbody>
      {groups.map((group) => {
        const single = group.payees[0];
        const expandable = group.payees.length > 1;
        const expanded = open.has(group.label);

        return (
          <Fragment key={group.label}>
            <tr className={`border-b border-slate-100 ${group.isLargest ? 'bg-emerald-50/60' : ''}`}>
              <td className="px-2.5 py-3">
                {expandable ? (
                  <button
                    type="button"
                    onClick={() => toggle(group.label)}
                    aria-expanded={expanded}
                    className="group inline-flex items-center gap-2 text-sm font-semibold"
                  >
                    <ChevronIcon />
                    <span className={group.isLargest ? 'text-emerald-800' : ''}>{group.label}</span>
                  </button>
                ) : (
                  <span className={`pl-5 font-semibold ${group.isLargest ? 'text-emerald-800' : ''}`}>
                    {group.label}
                  </span>
                )}

                {group.isLargest && <LargestTag />}
                {group.origin === 'model' ? (
                  <span
                    title="Grouped by AI"
                    className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-700 px-2 py-0.5 text-[11px] font-bold text-white"
                  >
                    <SparkIcon size={11} /> AI
                  </span>
                ) : (
                  <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-700">
                    Ungrouped
                  </span>
                )}

                <p className="mt-0.5 pl-5 text-xs text-slate-500">
                  {expandable
                    ? `${group.payees.length} ${
                        group.origin === 'other'
                          ? 'payees the model did not group'
                          : 'payees'
                      }`
                    : group.origin === 'other'
                      ? `1 payee the model did not group: ${single?.payee ?? ''}`
                      : (single?.payee ?? '')}
                </p>
              </td>
              <td className="px-2.5 py-3">
                <div
                  className="h-2 rounded bg-emerald-700/75"
                  style={{ width: shareWidth(group.totalMinor, largest) }}
                />
              </td>
              <Amount minor={group.totalMinor} />
            </tr>

            {expandable &&
              expanded &&
              group.payees.map((payee) => (
                <tr key={payee.payee} className="border-b border-slate-100 bg-slate-50/70 text-sm">
                  <td className="py-2 pl-10 pr-2.5" colSpan={2}>
                    {payee.payee}
                  </td>
                  <Amount minor={payee.totalMinor} />
                </tr>
              ))}
          </Fragment>
        );
      })}
    </tbody>
  );
};

/**
 * Both groupings, one table. Every amount is the API's, through the formatter;
 * the browser adds nothing up, including the total above this table.
 */
export const GroupsTable = ({ report }: { report: SpendingReport }) => {
  const largest = report.groups.reduce(
    (max, group) => (group.totalMinor > max ? group.totalMinor : max),
    0n,
  );

  return (
    <table className="w-full border-collapse">
      <caption className="sr-only">
        {report.grouping === 'meaning'
          ? 'Spending grouped by meaning'
          : 'Spending grouped by payee'}
      </caption>
      <Head />
      {report.grouping === 'meaning' ? (
        <ByMeaning groups={report.groups} largest={largest} />
      ) : (
        byName(report.groups, largest)
      )}
    </table>
  );
};
