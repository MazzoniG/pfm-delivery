import { useId } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
} from 'recharts';
import type { ProjectionResponse } from '@pfm/contracts';
import { formatMinorUnits } from '../../lib/money.js';
import { formatAsOf } from '../accounts/asOf.js';
import { formatDueOn } from './params.js';

type Props = {
  projection: ProjectionResponse;
};

/**
 * Solid to today from the ledger, dashed forward from what is scheduled, with
 * the boundary exactly at `asOf`.
 *
 * The two halves are separate series so they can carry different strokes, and
 * the boundary point is given to both — the same point, not an invented one —
 * so the dashed line starts where the solid one ends instead of floating away
 * from it.
 *
 * Every `Number` here is chart geometry. Not one of them is rendered: the
 * figures a user reads are the API's strings, formatted from `bigint`.
 */
export const ProjectionChart = ({ projection }: Props) => {
  const headingId = useId();
  const lastActual = projection.series.findLastIndex((point) => point.basis === 'actual');

  const data = projection.series.map((point, index) => ({
    on: point.on,
    actual: point.basis === 'actual' ? Number(point.netWorthMinor) : null,
    projected:
      point.basis === 'projected' || index === lastActual
        ? Number(point.netWorthMinor)
        : null,
  }));

  const first = projection.series.at(0)?.on ?? projection.asOf;

  return (
    <section
      aria-labelledby={headingId}
      className="mb-5 rounded-lg border border-slate-200 bg-white px-4 pb-3 pt-4"
    >
      <div className="mb-1.5 flex items-start justify-between gap-4">
        <h2 id={headingId} className="text-xs font-semibold text-slate-600">
          Projected balance
        </h2>
        <div className="text-right">
          <div className="text-xs font-semibold text-slate-500">
            On {formatAsOf(projection.to)}
          </div>
          {/* The API's figure, carried forward from net worth. The client never
              adds an occurrence to a balance. */}
          <div className="text-2xl font-semibold tabular-nums text-slate-900">
            {formatMinorUnits(projection.projectedNetWorthMinor)}
          </div>
        </div>
      </div>

      <div aria-hidden="true">
        <ResponsiveContainer width="100%" height={210}>
          <LineChart data={data} margin={{ top: 16, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid vertical={false} stroke="#eef2f0" />
            <XAxis
              dataKey="on"
              ticks={[first, projection.asOf, projection.to]}
              tickFormatter={formatDueOn}
              tick={{ fontSize: 11.5, fill: '#7c8c86' }}
              axisLine={{ stroke: '#b9ccbf' }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <ReferenceLine
              x={projection.asOf}
              stroke="#7c8c86"
              strokeDasharray="2 3"
              label={{ value: 'Today', position: 'insideTopRight', fontSize: 11.5, fill: '#7c8c86' }}
            />
            <Line
              type="linear"
              dataKey="actual"
              stroke="#1f5e4a"
              strokeWidth={2.2}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              type="linear"
              dataKey="projected"
              stroke="#1f5e4a"
              strokeWidth={2.2}
              strokeDasharray="6 5"
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="sr-only">
        Balance of {formatMinorUnits(projection.netWorthMinor)} today, projected to reach{' '}
        {formatMinorUnits(projection.projectedNetWorthMinor)} on {formatAsOf(projection.to)}.
      </p>

      <div className="mt-1.5 flex flex-wrap items-center gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-5 border-t-2 border-emerald-800" />
          What happened
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-5 border-t-2 border-dashed border-emerald-800" />
          What is scheduled
        </span>
      </div>
    </section>
  );
};
