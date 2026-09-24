import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endOfLastMonth, localIsoDate, parseIsoDate } from './asOf.js';

const original = process.env.TZ;

describe('as-of date resolution', () => {
  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles';
  });
  afterAll(() => {
    process.env.TZ = original;
  });

  it('resolves today from the local clock, not from UTC', () => {
    // 22:30 in Los Angeles on the 21st, already the 22nd in UTC.
    const lateEvening = new Date('2026-09-22T05:30:00Z');

    expect(lateEvening.toISOString().slice(0, 10)).toBe('2026-09-22');
    expect(localIsoDate(lateEvening)).toBe('2026-09-21');
  });

  it('gives the last day of the previous month', () => {
    expect(endOfLastMonth(new Date(2026, 8, 21))).toBe('2026-08-31');
    expect(endOfLastMonth(new Date(2026, 0, 3))).toBe('2025-12-31');
    expect(endOfLastMonth(new Date(2024, 2, 15))).toBe('2024-02-29');
  });

  it('rejects anything that is not a real calendar date', () => {
    expect(parseIsoDate('2026-02-31')).toBeNull();
    expect(parseIsoDate('2026-9-1')).toBeNull();
    expect(parseIsoDate('yesterday')).toBeNull();
    expect(parseIsoDate('2026-08-31')).not.toBeNull();
  });
});
