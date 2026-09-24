import type { RepeatRule } from '@pfm/contracts';

const DAY_MS = 86_400_000;

/**
 * A stepper that fails to advance is an infinite loop inside a request handler.
 * Nothing legitimate comes close: the horizon is capped at a year, so the
 * densest rule — weekly — produces fewer than sixty dates.
 */
const MAX_STEPS = 1_000;

const utcDate = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month, day));

/** `day 0` of the next month is the last day of this one. */
const daysInMonth = (year: number, month: number): number =>
  utcDate(year, month + 1, 0).getUTCDate();

/**
 * Monthly counts months from the anchor and clamps each one independently,
 * rather than stepping from the previous date. A series anchored on the 31st
 * therefore lands on the 28th in February and returns to the 31st in March —
 * stepping from the clamped date would leave it on the 28th forever.
 */
const nth = (rule: RepeatRule, firstDueOn: Date, step: number): Date => {
  switch (rule.frequency) {
    case 'one-off':
      return firstDueOn;
    case 'weekly':
      return new Date(firstDueOn.getTime() + step * 7 * DAY_MS);
    case 'biweekly':
      return new Date(firstDueOn.getTime() + step * 14 * DAY_MS);
    case 'monthly': {
      const year = firstDueOn.getUTCFullYear();
      const month = firstDueOn.getUTCMonth() + step;
      return utcDate(
        year,
        month,
        Math.min(rule.dayOfMonth, daysInMonth(year, month)),
      );
    }
  }
};

/**
 * The dates this rule falls on within `[from, to]`, counted from `firstDueOn`.
 *
 * Counting from the anchor rather than from `from` is what makes re-expansion
 * produce the same dates it produced last time: the sequence is a property of
 * the series, not of the window it is being asked about.
 */
export const occurrenceDates = (
  rule: RepeatRule,
  firstDueOn: Date,
  from: Date,
  to: Date,
): Date[] => {
  const dates: Date[] = [];
  if (to.getTime() < firstDueOn.getTime()) return dates;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const due = nth(rule, firstDueOn, step);
    if (due.getTime() > to.getTime()) return dates;
    if (due.getTime() >= from.getTime()) dates.push(due);
    if (rule.frequency === 'one-off') return dates;
  }

  throw new Error(`recurrence expanded past ${MAX_STEPS} occurrences`);
};
