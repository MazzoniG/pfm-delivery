import { z } from 'zod';
import { CalendarDate, Timestamp, Uuid } from './common.js';
import { MinorUnits } from './money.js';
import { withPeriodRules } from './report.js';

export const GroupingMode = z.enum(['name', 'meaning']);
export type GroupingMode = z.infer<typeof GroupingMode>;

/**
 * `grouping` is what the client asks for, not what it gets: `meaning` degrades
 * to `name` whenever the model is unavailable, unconsented or unreconcilable,
 * and the response says which one produced it.
 */
export const SpendingReportRequest = withPeriodRules(
  z.object({
    from: CalendarDate,
    to: CalendarDate,
    projectId: Uuid.optional(),
    grouping: GroupingMode.default('name'),
  }),
);
export type SpendingReportRequest = z.infer<typeof SpendingReportRequest>;

/**
 * One normalised payee and the SQL sums behind it. `categories` is every
 * expense category the payee was booked to in the period — usually one, more
 * when the same merchant was split across categories.
 */
export const PayeeTotal = z.object({
  payee: z.string(),
  totalMinor: MinorUnits,
  transactionCount: z.number().int().positive(),
  categories: z.array(z.string()).min(1),
});
export type PayeeTotal = z.infer<typeof PayeeTotal>;
export type PayeeTotalWire = z.input<typeof PayeeTotal>;

/**
 * `isLargest` is the API's answer to "highlight the more expensives", marked
 * here rather than compared in the browser, which never sees the figures as
 * numbers. At most one group carries it.
 */
export const NameGroup = PayeeTotal.extend({ isLargest: z.boolean() });
export type NameGroup = z.infer<typeof NameGroup>;
export type NameGroupWire = z.input<typeof NameGroup>;

/**
 * `origin` separates what the model grouped from what it left behind:
 * `other` collects the ungrouped payees, always sorts last regardless of size,
 * and is never `isLargest` — it is a remainder, not a kind of spending.
 *
 * `label` is model-authored text and renders as plain text, never interpreted.
 * `payees` is what makes the grouping inspectable; every figure in it is a SQL
 * sum, so the totals reconcile whether the client adds them or not.
 */
export const MeaningGroup = z.object({
  label: z.string(),
  origin: z.enum(['model', 'other']),
  totalMinor: MinorUnits,
  isLargest: z.boolean(),
  payees: z.array(PayeeTotal).min(1),
});
export type MeaningGroup = z.infer<typeof MeaningGroup>;
export type MeaningGroupWire = z.input<typeof MeaningGroup>;

/**
 * Why `meaning` was not delivered. `not-consented` and `no-key` mean nothing
 * was sent; the other two mean a call was made and its answer refused —
 * `unreconciled` specifically meaning the groups did not sum to the
 * deterministic total, which is a correctness failure, not a transport one.
 */
export const FallbackReason = z.enum([
  'no-key',
  'not-consented',
  'provider-failed',
  'unreconciled',
]);
export type FallbackReason = z.infer<typeof FallbackReason>;

/** The payload viewer's source: what left the process, and when. */
export const SentPayload = z.object({
  names: z.array(z.string()),
  at: Timestamp,
});
export type SentPayload = z.infer<typeof SentPayload>;
export type SentPayloadWire = z.input<typeof SentPayload>;

const reportPeriod = {
  from: CalendarDate,
  to: CalendarDate,
  /** The API's own figure, never the sum of `groups`: the browser adds no money. */
  totalMinor: MinorUnits,
};

/**
 * Groups are payees matched by normalised name. `fallback` is set only when
 * `meaning` was asked for and refused, and it is what the degraded notice
 * renders — absent when the client asked for this grouping in the first place.
 */
export const NameGroupedReport = z.object({
  ...reportPeriod,
  grouping: z.literal('name'),
  groups: z.array(NameGroup),
  fallback: FallbackReason.nullable(),
});

/**
 * Groups are the model's, over merchant names alone. `sent` is mandatory here:
 * a semantic report that cannot say what left the process is not shippable.
 */
export const MeaningGroupedReport = z.object({
  ...reportPeriod,
  grouping: z.literal('meaning'),
  groups: z.array(MeaningGroup),
  sent: SentPayload,
});

/**
 * A union rather than one shape with optional halves, so that the degraded
 * report cannot carry a label, a member list or a sent payload — the states the
 * UI must not confuse are the states the type system will not let it build.
 */
export const SpendingReport = z.discriminatedUnion('grouping', [
  NameGroupedReport,
  MeaningGroupedReport,
]);
export type SpendingReport = z.infer<typeof SpendingReport>;
export type SpendingReportWire = z.input<typeof SpendingReport>;

/**
 * Read before any report is generated, because the switch has to render its
 * own disabled reason. `semanticAvailable` is the server's key; `enabled` is
 * the owner's consent, which is revocable and is what gates every send.
 */
export const InsightsSettings = z.object({
  semanticAvailable: z.boolean(),
  enabled: z.boolean(),
});
export type InsightsSettings = z.infer<typeof InsightsSettings>;

export const UpdateInsightsSettingsRequest = z.object({ enabled: z.boolean() });
export type UpdateInsightsSettingsRequest = z.infer<
  typeof UpdateInsightsSettingsRequest
>;
