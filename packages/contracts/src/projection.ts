import { z } from 'zod';
import { CalendarDate } from './common.js';
import { MinorUnits } from './money.js';
import { ScheduledOccurrenceView } from './recurring.js';

/**
 * The furthest a projection reaches. Expansion writes occurrences up to the
 * horizon asked for, so an unbounded horizon is an unbounded number of rows for
 * an open-ended series — this is the ceiling that makes "never store infinite
 * future rows" true rather than aspirational. The bills page offers one, three
 * and six months; a year is well past anything the UI asks for.
 *
 * Compared against the server's today, so the check runs in the service. A
 * refinement here would need a clock, and a date decided at module load is the
 * trap {@link BalanceQuery} documents.
 *
 * Exceeding it is **400**, naming `to` in `errors`, exactly as an out-of-range
 * report period is: the value is a query parameter outside its permitted range.
 * {@link MAX_BACKDATED_DAYS} is a rule about schedules rather than a range on a
 * parameter, and answers 422 — see the note there.
 */
export const MAX_PROJECTION_MONTHS = 12;

/**
 * `to` is required and has no default. There is no natural horizon to fall back
 * on — one month and six months are both defensible, so the choice is the
 * caller's, and the segmented control writes it into the URL as a date.
 *
 * No bound against today: a default evaluated here would freeze the date at
 * module load, the trap {@link BalanceQuery} documents. The service resolves
 * today per request, and a `to` already in the past simply projects nothing,
 * which is the truthful answer rather than an error.
 */
export const ProjectionQuery = z.object({ to: CalendarDate });
export type ProjectionQuery = z.infer<typeof ProjectionQuery>;

/**
 * Which half of the line a point belongs to. `actual` is the ledger, `projected`
 * is the ledger plus what is scheduled — the solid and dashed segments, marked
 * by the API so the client draws the boundary rather than deciding where it is.
 */
export const ProjectionBasis = z.enum(['actual', 'projected']);
export type ProjectionBasis = z.infer<typeof ProjectionBasis>;

export const ProjectionPoint = z.object({
  on: CalendarDate,
  netWorthMinor: MinorUnits,
  basis: ProjectionBasis,
});
export type ProjectionPoint = z.infer<typeof ProjectionPoint>;
export type ProjectionPointWire = z.input<typeof ProjectionPoint>;

/**
 * `netMinor` is the API's own figure, not the sum of `occurrences`: the browser
 * adds no money, and a group whose rows were capped or filtered would otherwise
 * report a total that quietly disagrees with the projection it feeds.
 */
export const OccurrenceGroup = z.object({
  netMinor: MinorUnits,
  occurrences: z.array(ScheduledOccurrenceView),
});
export type OccurrenceGroup = z.infer<typeof OccurrenceGroup>;
export type OccurrenceGroupWire = z.input<typeof OccurrenceGroup>;

/**
 * Every figure here is net worth — the raw signed sum over asset and liability
 * accounts, exactly as `BalancesResponse.netWorthMinor` defines it, and never
 * sign-flipped. `netWorthMinor` is today's and is the same number the balances
 * panel shows; `projectedNetWorthMinor` is that figure carried to `to`.
 *
 * `overdue` is returned and is **not** in `projectedNetWorthMinor`. The
 * projection starts from today's balance, and an occurrence due before today
 * that was never materialised is money that has not moved — adding it would
 * claim a payment that did not happen. It is carried in its own group, with its
 * own net, because a forecast that silently drops an unpaid bill is worse than
 * one that flags it. Nothing dismisses an overdue occurrence: it stays listed
 * until it is paid, or its series is changed.
 *
 * `scheduled` is what the forward half of `series` is made of — occurrences due
 * between `asOf` and `to`, inclusive, that carry no `materializedEntryId`.
 * Future-dated real entries are in the figures too, but not in either group:
 * they are transactions, and they belong to the register.
 */
export const ProjectionResponse = z.object({
  /** The server's today, resolved per request: where `actual` becomes `projected`. */
  asOf: CalendarDate,
  to: CalendarDate,
  netWorthMinor: MinorUnits,
  projectedNetWorthMinor: MinorUnits,
  series: z.array(ProjectionPoint),
  overdue: OccurrenceGroup,
  scheduled: OccurrenceGroup,
});
export type ProjectionResponse = z.infer<typeof ProjectionResponse>;
export type ProjectionResponseWire = z.input<typeof ProjectionResponse>;
