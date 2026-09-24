import { useSearchParams } from 'react-router';
import type { RepeatRule } from '@pfm/contracts';
import { formatAsOf, localIsoDate, parseIsoDate } from '../accounts/asOf.js';

/** The three the segmented control offers, in months. */
export const HORIZONS = [1, 3, 6] as const;
export type Horizon = (typeof HORIZONS)[number];

const DEFAULT_HORIZON: Horizon = 1;

export const addMonths = (from: Date, months: number): string =>
  localIsoDate(new Date(from.getFullYear(), from.getMonth() + months, from.getDate()));

export type BillsParams = {
  /** The horizon as a calendar date — what the API is asked for, and what is shared. */
  to: string;
  today: string;
  /** The button that is pressed, or null when `to` came from a pasted link. */
  months: Horizon | null;
  label: string;
  setMonths(months: Horizon): void;
};

/**
 * The horizon lives in the URL as a **date**, not as a number of months: a link
 * shared today and opened next week has to mean the same forecast, and "three
 * months" would quietly mean a different one. The segmented control writes the
 * date; `months` is only which button to light up, recovered by comparing the
 * date back against today.
 *
 * One month is the default and is deliberately not written into the URL, so a
 * link that omits `to` keeps meaning "a month from whenever you open this".
 * A malformed or past date falls back to it as well — a forecast that ends
 * before it starts is not a question this view can answer.
 */
export const useBillsParams = (now: Date = new Date()): BillsParams => {
  const [params, setParams] = useSearchParams();

  const today = localIsoDate(now);
  const fallback = addMonths(now, DEFAULT_HORIZON);
  const param = params.get('to');
  const to = param !== null && parseIsoDate(param) !== null && param >= today ? param : fallback;

  const months = HORIZONS.find((count) => addMonths(now, count) === to) ?? null;

  return {
    to,
    today,
    months,
    label: formatAsOf(to),
    setMonths: (count) => {
      const next = new URLSearchParams(params);
      if (count === DEFAULT_HORIZON) next.delete('to');
      else next.set('to', addMonths(now, count));
      setParams(next, { replace: true });
    },
  };
};

const ORDINALS = new Intl.PluralRules('en-US', { type: 'ordinal' });
const SUFFIXES: Record<string, string> = {
  one: 'st',
  two: 'nd',
  few: 'rd',
  other: 'th',
};

export const ordinal = (day: number): string =>
  `${day}${SUFFIXES[ORDINALS.select(day)] ?? 'th'}`;

/** The chip beside a payee. The four shapes, in the words the dialog offers. */
export const describeRule = (rule: RepeatRule): string => {
  switch (rule.frequency) {
    case 'one-off':
      return 'One-off';
    case 'weekly':
      return 'Weekly';
    case 'biweekly':
      return 'Every two weeks';
    case 'monthly':
      return `Monthly on the ${ordinal(rule.dayOfMonth)}`;
  }
};

const DAY_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit' });

/** "Sep 19" — the register's own date column, which these rows sit beside. */
export const formatDueOn = (iso: string): string => {
  const date = parseIsoDate(iso);
  return date ? DAY_LABEL.format(date) : iso;
};
