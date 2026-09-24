import { useSearchParams } from 'react-router';

/**
 * The balance date is a calendar date, so it is resolved from the *local*
 * clock. `Date#toISOString()` is UTC and would hand a user at 00:30 east of
 * Greenwich yesterday's balance, so the register's `iso()` helper is
 * deliberately not reused here.
 */
export const localIsoDate = (date: Date): string => {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

/** Day 0 of this month is the last day of the previous one. */
export const endOfLastMonth = (now: Date): string =>
  localIsoDate(new Date(now.getFullYear(), now.getMonth(), 0));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const parseIsoDate = (value: string): Date | null => {
  if (!ISO_DATE.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  return localIsoDate(date) === value ? date : null;
};

const LABEL = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export const formatAsOf = (iso: string): string => {
  const date = parseIsoDate(iso);
  return date ? LABEL.format(date) : iso;
};

export type AsOfState = {
  /** The date sent to the API on every request, never left implicit. */
  asOf: string;
  today: string;
  isPast: boolean;
  /** "Today" or "Aug 31, 2026". */
  label: string;
  /** "As of today" or "As of Aug 31, 2026". */
  whenLabel: string;
  select(date: string): void;
  backToToday(): void;
};

export const useAsOf = (now: Date = new Date()): AsOfState => {
  const [params, setParams] = useSearchParams();

  const today = localIsoDate(now);
  const param = params.get('asOf');
  // The picker caps at today, because a balance after today is a projection and
  // belongs to US4. A future or malformed date pasted into the URL is therefore
  // not a question this view can answer, and falls back to today.
  const asOf = param !== null && parseIsoDate(param) !== null && param <= today ? param : today;
  const isPast = asOf !== today;

  const write = (value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete('asOf');
    else next.set('asOf', value);
    setParams(next, { replace: true });
  };

  return {
    asOf,
    today,
    isPast,
    label: isPast ? formatAsOf(asOf) : 'Today',
    whenLabel: isPast ? `As of ${formatAsOf(asOf)}` : 'As of today',
    // Picking today deletes the param instead of writing today's date into it:
    // a link shared today and opened tomorrow has to mean tomorrow.
    select: (date) => write(date === today ? null : date),
    backToToday: () => write(null),
  };
};
