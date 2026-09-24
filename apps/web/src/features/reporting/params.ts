import { useSearchParams } from 'react-router';
import { MAX_REPORT_MONTHS } from '@pfm/contracts';
import { localIsoDate } from '../accounts/asOf.js';

/**
 * The URL is the state. `from` and `to` are dates, always whole months when
 * the range control wrote them; `month` is the selected bar and never reaches
 * the API — every month comes back in one response. An absent range means the
 * last six months and an absent `month` the latest month in range, so neither
 * default is written into a link that is shared and opened later.
 */
export const RANGES = {
  '3m': 'Last 3 months',
  '6m': 'Last 6 months',
  '12m': 'Last 12 months',
  ytd: 'This year',
} as const;

export type Range = keyof typeof RANGES;

const DEFAULT_RANGE: Range = '6m';

const pad = (n: number): string => `${n}`.padStart(2, '0');

/** Months, like the balance date, come from the local calendar. */
const firstOfMonth = (year: number, monthIndex: number): string =>
  localIsoDate(new Date(year, monthIndex, 1));

/** Day 0 of the next month is the last day of this one. */
export const monthEnd = (month: string): string => {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return localIsoDate(new Date(year, index, 0));
};

export const monthStart = (month: string): string => `${month}-01`;

/** Month labels for the loading skeleton, so it keeps the chart's geometry. */
export const monthsBetween = (from: string, to: string): string[] => {
  if (!/^\d{4}-\d{2}/.test(from) || !/^\d{4}-\d{2}/.test(to)) return [];
  const labels: string[] = [];
  let [year, index] = from.split('-').map(Number) as [number, number];
  const last = to.slice(0, 7);
  for (let guard = 0; guard < MAX_REPORT_MONTHS; guard += 1) {
    const month = `${year}-${`${index}`.padStart(2, '0')}`;
    if (month > last) break;
    labels.push(month);
    index += 1;
    if (index > 12) {
      index = 1;
      year += 1;
    }
  }
  return labels;
};

export const rangeDates = (range: Range, now: Date): { from: string; to: string } => {
  const year = now.getFullYear();
  const index = now.getMonth();
  const to = monthEnd(`${year}-${pad(index + 1)}`);
  switch (range) {
    case '3m':
      return { from: firstOfMonth(year, index - 2), to };
    case '6m':
      return { from: firstOfMonth(year, index - 5), to };
    case '12m':
      return { from: firstOfMonth(year, index - 11), to };
    case 'ytd':
      return { from: `${year}-01-01`, to };
  }
};

const MONTH_LONG = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const MONTH_SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
const DAY_SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });

const utc = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

export const formatMonthLong = (month: string): string => MONTH_LONG.format(utc(monthStart(month)));
export const formatMonthShort = (month: string): string => MONTH_SHORT.format(utc(monthStart(month)));
export const formatDayShort = (iso: string): string => DAY_SHORT.format(utc(iso));

export type ReportParams = {
  from: string;
  to: string;
  /** The preset the range matches, or null for a range pasted in by hand. */
  range: Range | null;
  month: string | null;
  today: string;
  setRange(range: Range): void;
  selectMonth(month: string): void;
  /** A link to `month` in this report, widening the range to include it. */
  monthHref(month: string): string;
};

export const useReportParams = (now: Date = new Date()): ReportParams => {
  const [params, setParams] = useSearchParams();
  const fallback = rangeDates(DEFAULT_RANGE, now);

  // Passed to the API as found, even when malformed or reversed: the API owns
  // those rules, and its problem detail is what the error state renders.
  const from = params.get('from') ?? fallback.from;
  const to = params.get('to') ?? fallback.to;

  const range =
    (Object.keys(RANGES) as Range[]).find((key) => {
      const dates = rangeDates(key, now);
      return dates.from === from && dates.to === to;
    }) ?? null;

  const write = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  return {
    from,
    to,
    range,
    month: params.get('month'),
    today: localIsoDate(now),
    setRange: (next) => write({ ...rangeDates(next, now), month: null }),
    selectMonth: (month) => write({ month }),
    monthHref: (month) => {
      const next = new URLSearchParams(params);
      next.set('from', monthStart(month) < from ? monthStart(month) : from);
      next.set('to', monthEnd(month) > to ? monthEnd(month) : to);
      next.set('month', month);
      return `?${next.toString()}`;
    },
  };
};
