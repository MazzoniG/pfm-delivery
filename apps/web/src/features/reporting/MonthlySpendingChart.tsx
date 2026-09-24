import { useId } from 'react';
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer } from 'recharts';
import type { MonthSpending } from '@pfm/contracts';
import { formatMinorUnits } from '../../lib/money.js';
import { formatMonthLong, formatMonthShort } from './params.js';

const SELECTED = '#047857';
const IDLE = '#cfded5';

type Props = {
  months: MonthSpending[];
  /** Without `onSelect` the chart is read-only and no bar is selected. */
  selected?: string;
  /** The current month, still being spent in; drawn hatched. */
  partialMonth: string | null;
  onSelect?: (month: string) => void;
  title?: string;
};

/**
 * Recharts draws the bars; the month buttons beneath them are what a keyboard
 * or a screen reader uses, and they line up with the bars because the chart
 * has no axis or side margin to offset its bands.
 */
export const MonthlySpendingChart = ({
  months,
  selected,
  partialMonth,
  onSelect,
  title = 'Spending per month',
}: Props) => {
  const headingId = useId();
  const data = months.map((m) => ({
    month: m.month,
    // A JS number for bar height only. The label drawn on the bar is the
    // API's string through the formatter, never this value. A month a
    // correction took below zero sits on the baseline; its label keeps the sign.
    height: m.totalMinor > 0n ? Number(m.totalMinor) : 0,
    label: formatMinorUnits(m.totalMinor),
  }));

  return (
    <section aria-labelledby={headingId} className="mb-5 rounded-lg border border-slate-200 bg-white px-4 pb-3 pt-4">
      <h2 id={headingId} className="mb-3 text-xs font-semibold text-slate-600">
        {title}
      </h2>

      <div aria-hidden="true">
        <ResponsiveContainer width="100%" height={190}>
          <BarChart data={data} margin={{ top: 20, right: 0, bottom: 0, left: 0 }} barCategoryGap="18%">
            <defs>
              <pattern id="partial-idle" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="8" height="8" fill={IDLE} />
                <rect width="4" height="8" fill="#e2ece6" />
              </pattern>
              <pattern id="partial-selected" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="8" height="8" fill={SELECTED} />
                <rect width="4" height="8" fill="#2d7760" />
              </pattern>
            </defs>
            <Bar
              dataKey="height"
              radius={[5, 5, 0, 0]}
              minPointSize={2}
              maxBarSize={64}
              isAnimationActive={false}
              cursor={onSelect ? 'pointer' : 'default'}
              onClick={(_, index) => {
                const month = months[index]?.month;
                if (month) onSelect?.(month);
              }}
            >
              {data.map((d) => {
                const isSelected = d.month === selected;
                const fill =
                  d.month === partialMonth
                    ? `url(#partial-${isSelected ? 'selected' : 'idle'})`
                    : isSelected
                      ? SELECTED
                      : IDLE;
                return <Cell key={d.month} fill={fill} />;
              })}
              <LabelList dataKey="label" position="top" fontSize={12} fill="#475569" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div
        className="mt-2 grid border-t border-slate-300 pt-2"
        style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}
      >
        {months.map((m) => {
          const isSelected = m.month === selected;
          if (!onSelect) {
            return (
              <span
                key={m.month}
                aria-label={`${formatMonthLong(m.month)}, ${formatMinorUnits(m.totalMinor)} spent`}
                className="text-center text-xs text-slate-600"
              >
                {formatMonthShort(m.month)}
              </span>
            );
          }
          return (
            <button
              key={m.month}
              type="button"
              aria-pressed={isSelected}
              aria-label={`${formatMonthLong(m.month)}, ${formatMinorUnits(m.totalMinor)} spent`}
              onClick={() => onSelect(m.month)}
              className={`rounded text-center text-xs ${
                isSelected ? 'font-bold text-slate-900' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {formatMonthShort(m.month)}
            </button>
          );
        })}
      </div>
    </section>
  );
};

export const MonthlySpendingChartSkeleton = ({
  labels,
  title = 'Spending per month',
}: {
  labels: string[];
  title?: string;
}) => (
  <section aria-busy="true" className="mb-5 rounded-lg border border-slate-200 bg-white px-4 pb-3 pt-4">
    <h2 className="mb-3 text-xs font-semibold text-slate-600">{title}</h2>
    <div className="flex h-[190px] items-end gap-3.5">
      {labels.map((label) => (
        <div key={label} className="flex flex-1 justify-center">
          <div className="h-14 w-[70%] rounded-t bg-slate-100 motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
    <div
      className="mt-2 grid border-t border-slate-300 pt-2"
      style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))` }}
    >
      {labels.map((label) => (
        <span key={label} className="text-center text-xs text-slate-400">
          {label}
        </span>
      ))}
    </div>
  </section>
);
