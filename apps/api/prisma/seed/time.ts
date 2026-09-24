/**
 * Every date hangs off today, so the demo is always current: six months of
 * history ending now, rather than a fixed window that ages into irrelevance.
 * Dates are built in UTC because `occurred_on` is a calendar date and must not
 * shift under the machine's timezone.
 */
export const todayUtc = (): Date => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
};

export const utcDate = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month, day));

export const startOfMonth = (date: Date): Date =>
  utcDate(date.getUTCFullYear(), date.getUTCMonth(), 1);

export const addMonths = (date: Date, months: number): Date =>
  utcDate(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate());

export const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 86_400_000);

export const dayOfMonth = (month: Date, day: number): Date =>
  utcDate(month.getUTCFullYear(), month.getUTCMonth(), day);

export const daysInMonth = (month: Date): number =>
  utcDate(month.getUTCFullYear(), month.getUTCMonth() + 1, 0).getUTCDate();

export const sameMonth = (a: Date, b: Date): boolean =>
  a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();

/** An audit instant on a calendar day — `TIMESTAMPTZ` from a `DATE`, never the reverse. */
export const atHour = (date: Date, hourUtc: number): Date =>
  new Date(date.getTime() + hourUtc * 3_600_000);
