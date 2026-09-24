import { formatMinorUnits } from '../../lib/money.js';

type Props = {
  /** Absent means the figure is not available — never a zero invented here. */
  value: bigint | undefined;
  pending: boolean;
  /** A liability's amount is already positive; this labels what it means. */
  owed?: boolean;
  className?: string;
  barClassName?: string;
  owedClassName?: string;
};

export const BalanceFigure = ({
  value,
  pending,
  owed = false,
  className = '',
  barClassName = 'h-3 w-14',
  owedClassName = 'ml-1 text-[11px] font-semibold text-slate-500',
}: Props) => {
  if (pending) {
    return (
      <span className={className}>
        <span
          aria-hidden="true"
          className={`inline-block animate-pulse rounded bg-slate-200 align-middle ${barClassName}`}
        />
        <span className="sr-only">Loading balance</span>
      </span>
    );
  }

  if (value === undefined) {
    return (
      <span className={`${className} text-slate-400`}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">Balance unavailable</span>
      </span>
    );
  }

  // A minus sign stays in normal ink: an overdrawn account is information, and
  // red is reserved for errors.
  return (
    <span className={className}>
      {formatMinorUnits(value)}
      {owed && <span className={owedClassName}>owed</span>}
    </span>
  );
};
