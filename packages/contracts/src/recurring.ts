import { z } from 'zod';
import { CalendarDate, Timestamp, Uuid } from './common.js';
import { Entry } from './entry.js';
import { MinorUnits } from './money.js';
import { ProblemDetails } from './problem.js';

/**
 * Four shapes and no more: one-off, weekly, every two weeks, monthly on a day.
 * There is no generic `interval`, and no RRULE — an open interval field would
 * admit a fifth shape by arithmetic, and the expansion code would then have to
 * answer questions ("every 3 weeks from when, across a DST boundary") that this
 * story never asks. Biweekly is its own frequency for exactly that reason.
 *
 * `strictObject` rather than the default: an unknown key is rejected instead of
 * stripped, so `{ frequency: 'weekly', dayOfMonth: 5 }` is a 400 rather than a
 * weekly rule that silently lost half of what the caller meant.
 */
export const REPEAT_FREQUENCIES = [
  'one-off',
  'weekly',
  'biweekly',
  'monthly',
] as const;

export const RepeatRule = z.discriminatedUnion('frequency', [
  z.strictObject({ frequency: z.literal('one-off') }),
  z.strictObject({ frequency: z.literal('weekly') }),
  z.strictObject({ frequency: z.literal('biweekly') }),
  z.strictObject({
    frequency: z.literal('monthly'),
    /**
     * The anchor day, 1–31. A day past the end of a shorter month lands on that
     * month's last day, which is why this is stored rather than derived from the
     * first due date: a series anchored on the 31st still reads "monthly on the
     * 31st" in the month it fell on the 28th.
     */
    dayOfMonth: z.number().int().min(1).max(31),
  }),
]);
export type RepeatRule = z.infer<typeof RepeatRule>;

/**
 * The stored pair — a frequency and a nullable anchor day — assembled into the
 * tagged rule, where the day exists only on the shape that has one. Every
 * reader of a series row goes through this rather than rebuilding the union,
 * so a fifth shape has one place to be taught about.
 *
 * A null day on a monthly row is corruption, not a case: the database has a
 * CHECK constraint pairing the two, and the alternative to throwing is
 * inventing an anchor and quietly expanding a bill onto the wrong date.
 */
export const repeatRuleOf = (
  frequency: RepeatRule['frequency'],
  dayOfMonth: number | null,
  describe: string,
): RepeatRule => {
  if (frequency !== 'monthly') return { frequency };
  if (dayOfMonth === null) {
    throw new Error(`monthly series ${describe} has no anchor day`);
  }
  return { frequency, dayOfMonth };
};

export const SeriesPayee = z.string().trim().min(1).max(120);

/**
 * How far back a new series may be anchored. A schedule describes what is
 * coming; one anchored years ago would expand into hundreds of occurrences that
 * were never bills, and the overdue group — which nothing dismisses — would
 * carry every one of them. A month is enough to record the bill you missed.
 *
 * Compared against the server's today, so the check runs in the service — a
 * refinement here would need a clock, and a date decided at module load is the
 * trap {@link BalanceQuery} documents. The number lives in the contract so the
 * form that picks the date and the service that rejects it read the same one.
 *
 * **It answers 422, and {@link MAX_PROJECTION_MONTHS} answers 400.** The two
 * share a reason for running late and nothing else. A `to` outside its range is
 * an out-of-range query parameter, which is what `withPeriodRules` already
 * answers 400 for; a `firstDueOn` of five years ago is a perfectly good
 * calendar date that violates a rule about what a schedule is, which is the
 * class `POST /recurring` already answers 422 for on the line above it — an
 * account of the wrong kind. Matching the horizon here would make one body
 * field on this endpoint disagree with the two beside it.
 */
export const MAX_BACKDATED_DAYS = 31;

const daysInMonthOf = (isoDate: string): number =>
  new Date(
    Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)), 0),
  ).getUTCDate();

/**
 * The anchor day and the first due date must agree, or the series contradicts
 * itself before it expands once. They agree when the date falls on the anchor
 * day, or when the anchor is past the end of that month and the date is its last
 * day — the same clamp expansion applies, checked where the series is created.
 */
export const anchorsToFirstDue = (
  firstDueOn: string,
  dayOfMonth: number,
): boolean => {
  const day = Number(firstDueOn.slice(8, 10));
  return (
    day === dayOfMonth ||
    (dayOfMonth > day && day === daysInMonthOf(firstDueOn))
  );
};

/**
 * `amountMinor` is the signed amount that will be posted to `ledgerAccountId` —
 * the asset or liability side — and `categoryId` takes its exact negation, the
 * same sugar as {@link CreateEntrySimple}. So a bill is negative and income
 * positive, whichever side of the chart funds it: rent from checking is
 * −165000, a gym charge on a credit card is −3500 because more is owed.
 *
 * That is the net-worth basis, identical to `BalancesResponse.netWorthMinor`,
 * and it is why nothing in this phase calls `displaySign`: every figure here is
 * already in the basis the projection reports.
 *
 * Which kinds `ledgerAccountId` and `categoryId` may name is the service's rule,
 * as on {@link EntryLineInput} — the account a line names is what decides it.
 */
export const RecurringSeries = z.object({
  id: Uuid,
  payee: SeriesPayee,
  amountMinor: MinorUnits,
  ledgerAccountId: Uuid,
  categoryId: Uuid,
  rule: RepeatRule,
  firstDueOn: CalendarDate,
  /** Null is "until further notice" — no horizon, not an infinite row count. */
  endsOn: CalendarDate.nullable(),
  createdAt: Timestamp,
});
export type RecurringSeries = z.infer<typeof RecurringSeries>;
export type RecurringSeriesWire = z.input<typeof RecurringSeries>;

const occurrence = {
  id: Uuid,
  seriesId: Uuid,
  dueOn: CalendarDate,
  /** The series' amount as expanded onto this date, in the same net-worth basis. */
  amountMinor: MinorUnits,
};

/**
 * A scheduled occurrence is not an entry. It has not happened, it is in no
 * balance and no report, and `materializedEntryId` is the only thing that ever
 * takes it out of the projection — nothing dismisses one.
 */
export const ScheduledOccurrence = z.object({
  ...occurrence,
  materializedEntryId: Uuid.nullable(),
});
export type ScheduledOccurrence = z.infer<typeof ScheduledOccurrence>;
export type ScheduledOccurrenceWire = z.input<typeof ScheduledOccurrence>;

/**
 * One row of the bills list: the occurrence plus the names the list renders, so
 * the page needs no second request to say what "Rent, Everyday Checking" is.
 *
 * No `materializedEntryId`: a materialised occurrence is a transaction and
 * belongs to the register, so it never appears in a group here, and a field
 * that could only ever be null would say otherwise.
 */
export const ScheduledOccurrenceView = z.object({
  ...occurrence,
  payee: SeriesPayee,
  rule: RepeatRule,
  ledgerAccountId: Uuid,
  ledgerAccountName: z.string(),
  categoryId: Uuid,
  categoryName: z.string(),
});
export type ScheduledOccurrenceView = z.infer<typeof ScheduledOccurrenceView>;
export type ScheduledOccurrenceViewWire = z.input<
  typeof ScheduledOccurrenceView
>;

export const CreateRecurringSeriesRequest = z
  .object({
    payee: SeriesPayee,
    amountMinor: MinorUnits.refine((v) => v !== 0n, 'must not be zero'),
    ledgerAccountId: Uuid,
    categoryId: Uuid,
    rule: RepeatRule,
    firstDueOn: CalendarDate,
    endsOn: CalendarDate.nullable().default(null),
  })
  .refine(
    (series) => series.endsOn === null || series.endsOn >= series.firstDueOn,
    {
      message: 'must be on or after firstDueOn',
      path: ['endsOn'],
    },
  )
  .refine(
    (series) =>
      series.rule.frequency !== 'monthly' ||
      anchorsToFirstDue(series.firstDueOn, series.rule.dayOfMonth),
    {
      message: 'must fall on the rule’s day of the month',
      path: ['firstDueOn'],
    },
  );
export type CreateRecurringSeriesRequest = z.infer<
  typeof CreateRecurringSeriesRequest
>;
export type CreateRecurringSeriesRequestWire = z.input<
  typeof CreateRecurringSeriesRequest
>;

/**
 * All three fields are required and none is defaulted, because all three are
 * prefilled from the occurrence and all three are editable: a bill rarely
 * arrives on exactly its scheduled date for exactly its scheduled amount. A
 * server-side default would also be a date decided at module load, the trap
 * {@link BalanceQuery} documents.
 *
 * `amountMinor` keeps the account-side sign, so paying a bill for more than
 * scheduled is a more negative number, not a larger one.
 */
export const PayOccurrenceRequest = z.object({
  paidOn: CalendarDate,
  amountMinor: MinorUnits.refine((v) => v !== 0n, 'must not be zero'),
  ledgerAccountId: Uuid,
});
export type PayOccurrenceRequest = z.infer<typeof PayOccurrenceRequest>;
export type PayOccurrenceRequestWire = z.input<typeof PayOccurrenceRequest>;

/**
 * The entry is an ordinary one, posted through the same path as any other — the
 * link is what makes it a payment. Both halves come back because the caller has
 * to show the transaction it just created and drop the row it came from.
 */
export const PayOccurrenceResponse = z.object({
  occurrence: ScheduledOccurrence,
  entry: Entry,
});
export type PayOccurrenceResponse = z.infer<typeof PayOccurrenceResponse>;
export type PayOccurrenceResponseWire = z.input<typeof PayOccurrenceResponse>;

/**
 * The 409 from paying an occurrence twice. It names the entry that already
 * materialised it, so the client can open that transaction instead of posting a
 * second one — double-payment is the failure this whole link exists to prevent.
 */
export const OccurrencePaidProblem = ProblemDetails.extend({
  status: z.literal(409),
  materializedEntryId: Uuid,
});
export type OccurrencePaidProblem = z.infer<typeof OccurrencePaidProblem>;

export const OccurrenceIdParam = z.object({ id: Uuid });
export type OccurrenceIdParam = z.infer<typeof OccurrenceIdParam>;
