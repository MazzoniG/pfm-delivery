import { describe, expect, it } from 'vitest';
import { anchorsToFirstDue, type RepeatRule } from '@pfm/contracts';
import { occurrenceDates } from './rules.js';

// US4 — the recurrence itself, at arbitrary dates. The API can only be asked
// about the twelve months after today, so the calendar decides which cases a
// request can reach; this function cannot be, and February is pinned here for
// that reason rather than in the contract suite.
//
// The criteria are the contract's: four shapes and no more (`RepeatRule`), and
// "a day past the end of a shorter month lands on that month's last day ... a
// series anchored on the 31st still reads monthly on the 31st in the month it
// fell on the 28th" (`RepeatRule.dayOfMonth`).

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const iso = (value: Date): string => value.toISOString().slice(0, 10);

const dates = (
  rule: RepeatRule,
  firstDueOn: string,
  from: string,
  to: string,
): string[] =>
  occurrenceDates(rule, day(firstDueOn), day(from), day(to)).map(iso);

/** Every date the rule falls on from its anchor onwards. */
const from = (rule: RepeatRule, firstDueOn: string, to: string): string[] =>
  dates(rule, firstDueOn, firstDueOn, to);

const monthly = (dayOfMonth: number): RepeatRule => ({
  frequency: 'monthly',
  dayOfMonth,
});

describe('monthly clamps to a short month and recovers the anchor day', () => {
  it('lands on the 28th in February and returns to the 31st in March', () => {
    expect(from(monthly(31), '2027-01-31', '2027-04-30')).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
    ]);
  });

  it('lands on the 29th in a leap February', () => {
    expect(from(monthly(31), '2028-01-31', '2028-03-31')).toEqual([
      '2028-01-31',
      '2028-02-29',
      '2028-03-31',
    ]);
  });

  it('never sticks to a clamped day — a whole year on the 31st', () => {
    expect(from(monthly(31), '2027-01-31', '2027-12-31')).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
      '2027-05-31',
      '2027-06-30',
      '2027-07-31',
      '2027-08-31',
      '2027-09-30',
      '2027-10-31',
      '2027-11-30',
      '2027-12-31',
    ]);
  });

  it('keeps the anchor across four years of Februaries, leap and common', () => {
    const februaries = from(monthly(31), '2026-01-31', '2029-12-31').filter(
      (due) => due.slice(5, 7) === '02',
    );
    expect(februaries).toEqual([
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
      '2029-02-28',
    ]);
  });

  it('clamps the 30th and the 29th to the same last day, and only in February', () => {
    expect(from(monthly(30), '2027-01-30', '2027-04-30')).toEqual([
      '2027-01-30',
      '2027-02-28',
      '2027-03-30',
      '2027-04-30',
    ]);
    expect(from(monthly(29), '2027-01-29', '2027-04-29')).toEqual([
      '2027-01-29',
      '2027-02-28',
      '2027-03-29',
      '2027-04-29',
    ]);
    // The 29th is not clamped at all in a leap year.
    expect(from(monthly(29), '2028-01-29', '2028-03-29')).toEqual([
      '2028-01-29',
      '2028-02-29',
      '2028-03-29',
    ]);
  });

  it('carries the anchor over a year boundary', () => {
    expect(from(monthly(31), '2027-11-30', '2028-02-29')).toEqual([
      '2027-11-30',
      '2027-12-31',
      '2028-01-31',
      '2028-02-29',
    ]);
  });

  it('an anchor of 28 or less never moves', () => {
    const due = from(monthly(28), '2027-01-28', '2028-01-28');
    expect(due).toHaveLength(13);
    for (const date of due) expect(date.slice(8, 10)).toBe('28');
  });

  it('expands from an anchor that is itself a clamped date', () => {
    // `anchorsToFirstDue` admits 31 anchored on a 30-day month's last day.
    expect(anchorsToFirstDue('2027-04-30', 31)).toBe(true);
    expect(from(monthly(31), '2027-04-30', '2027-07-31')).toEqual([
      '2027-04-30',
      '2027-05-31',
      '2027-06-30',
      '2027-07-31',
    ]);
  });
});

describe('the other three shapes', () => {
  it('repeats a one-off never, however far the window reaches', () => {
    expect(from({ frequency: 'one-off' }, '2027-03-09', '2030-01-01')).toEqual([
      '2027-03-09',
    ]);
  });

  it('steps weekly by seven days, across months and a year end', () => {
    expect(from({ frequency: 'weekly' }, '2027-12-20', '2028-01-24')).toEqual([
      '2027-12-20',
      '2027-12-27',
      '2028-01-03',
      '2028-01-10',
      '2028-01-17',
      '2028-01-24',
    ]);
  });

  it('steps weekly across a daylight-saving boundary without drifting', () => {
    // Calendar dates, so a clock change is not an event: the day of the week
    // and the interval both hold through the US and EU spring transitions.
    const due = from({ frequency: 'weekly' }, '2027-03-07', '2027-04-11');
    expect(due).toEqual([
      '2027-03-07',
      '2027-03-14',
      '2027-03-21',
      '2027-03-28',
      '2027-04-04',
      '2027-04-11',
    ]);
    for (const date of due) expect(day(date).getUTCDay()).toBe(0);
  });

  it('steps biweekly by fourteen days, and is not two weekly series', () => {
    const due = from({ frequency: 'biweekly' }, '2027-02-11', '2027-04-22');
    expect(due).toEqual([
      '2027-02-11',
      '2027-02-25',
      '2027-03-11',
      '2027-03-25',
      '2027-04-08',
      '2027-04-22',
    ]);
    expect(due).not.toContain('2027-02-18');
  });
});

describe('the window selects dates, it never moves them', () => {
  const rules: [string, RepeatRule, string][] = [
    ['one-off', { frequency: 'one-off' }, '2027-01-31'],
    ['weekly', { frequency: 'weekly' }, '2027-01-31'],
    ['biweekly', { frequency: 'biweekly' }, '2027-01-31'],
    ['monthly on the 31st', monthly(31), '2027-01-31'],
  ];

  it.each(rules)(
    '%s counts from its anchor, so a later window is a suffix of the whole sequence',
    (_label, rule, anchor) => {
      const whole = from(rule, anchor, '2028-01-31');
      const later = dates(rule, anchor, '2027-06-01', '2028-01-31');

      expect(later).toEqual(whole.filter((due) => due >= '2027-06-01'));
      // Re-asking a narrower window is the same answer, which is what makes
      // re-expansion idempotent rather than merely usually idempotent.
      expect(dates(rule, anchor, '2027-06-01', '2027-09-30')).toEqual(
        whole.filter((due) => due >= '2027-06-01' && due <= '2027-09-30'),
      );
    },
  );

  it('returns nothing for a window that closes before the anchor', () => {
    expect(
      dates(monthly(31), '2027-01-31', '2026-01-01', '2027-01-30'),
    ).toEqual([]);
    expect(
      dates({ frequency: 'weekly' }, '2027-01-31', '2026-01-01', '2027-01-30'),
    ).toEqual([]);
  });

  it('includes both ends of the window', () => {
    expect(
      dates(monthly(31), '2027-01-31', '2027-02-28', '2027-03-31'),
    ).toEqual(['2027-02-28', '2027-03-31']);
  });
});

describe('anchorsToFirstDue — the anchor and the first due date agree', () => {
  it.each([
    ['the anchor day itself', '2027-03-31', 31],
    ['a short month’s last day under a higher anchor', '2027-04-30', 31],
    ['February under an anchor of 31', '2027-02-28', 31],
    ['a leap February under an anchor of 30', '2028-02-29', 30],
    ['an anchor that needs no clamp', '2027-02-15', 15],
  ])('accepts %s', (_label, firstDueOn, dayOfMonth) => {
    expect(anchorsToFirstDue(firstDueOn, dayOfMonth)).toBe(true);
  });

  it.each([
    ['a date that is not the anchor day', '2027-03-30', 31],
    ['a day before the month’s end under a higher anchor', '2027-04-29', 31],
    ['an anchor lower than the date', '2027-03-31', 15],
    [
      'a leap February under an anchor of 31 is still its last day',
      '2028-02-28',
      31,
    ],
  ])('rejects %s', (_label, firstDueOn, dayOfMonth) => {
    expect(anchorsToFirstDue(firstDueOn, dayOfMonth)).toBe(false);
  });
});
