import {
  minorUnitsToString,
  repeatRuleOf,
  type RecurringSeriesWire,
  type RepeatRule,
  type ScheduledOccurrenceWire,
} from '@pfm/contracts';
import type { OccurrenceRow, SeriesRow } from './repository.js';

const calendarDate = (date: Date): string => date.toISOString().slice(0, 10);

/** Prisma's enum member against the contract's kebab-case wire value. */
export const wireFrequency = (
  frequency: SeriesRow['frequency'],
): RepeatRule['frequency'] => (frequency === 'oneOff' ? 'one-off' : frequency);

export const toRepeatRule = (row: {
  id: string;
  frequency: SeriesRow['frequency'];
  dayOfMonth: number | null;
}): RepeatRule => repeatRuleOf(wireFrequency(row.frequency), row.dayOfMonth, row.id);

export const toRecurringSeries = (row: SeriesRow): RecurringSeriesWire => ({
  id: row.id,
  payee: row.payee,
  // As posted to the account side, which is the sign it will carry into the
  // ledger. No display flip: see ADR-028.
  amountMinor: minorUnitsToString(row.amountMinor),
  ledgerAccountId: row.ledgerAccountId,
  categoryId: row.categoryId,
  rule: toRepeatRule(row),
  firstDueOn: calendarDate(row.firstDueOn),
  endsOn: row.endsOn ? calendarDate(row.endsOn) : null,
  createdAt: row.createdAt.toISOString(),
});

export const toScheduledOccurrence = (
  row: OccurrenceRow,
): ScheduledOccurrenceWire => ({
  id: row.id,
  seriesId: row.seriesId,
  dueOn: calendarDate(row.dueOn),
  amountMinor: minorUnitsToString(row.amountMinor),
  materializedEntryId: row.materializedEntryId,
});
