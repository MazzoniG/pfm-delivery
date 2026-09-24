import { z } from 'zod';
import {
  CalendarDate,
  EntryRef,
  LedgerAccountKind,
  PageQuery,
  Timestamp,
  Uuid,
  page,
} from './common.js';
import { EntryLine, EntryLineInput, sumsToZero } from './line.js';
import { MinorUnits } from './money.js';
import { ProblemDetails } from './problem.js';

/**
 * There is no status field. An entry is reversed when another entry reverses
 * it, so `reversedByEntryId` is read back from that entry rather than stored,
 * and cannot disagree with the correction it describes.
 */
export const Entry = z.object({
  id: Uuid,
  occurredOn: CalendarDate,
  description: z.string().nullable(),
  payee: z.string().nullable(),
  memo: z.string().nullable(),
  lockedAt: Timestamp.nullable(),
  reversesEntryId: Uuid.nullable(),
  replacesEntryId: Uuid.nullable(),
  reversedByEntryId: Uuid.nullable(),
  recordedAt: Timestamp,
  lines: z.array(EntryLine).min(2),
});
export type Entry = z.infer<typeof Entry>;
export type EntryWire = z.input<typeof Entry>;

const header = {
  occurredOn: CalendarDate,
  description: z.string().trim().max(200).nullable(),
  payee: z.string().trim().max(120).nullable(),
  memo: z.string().trim().max(500).nullable(),
};

const EntryHeaderInput = z.object({
  occurredOn: header.occurredOn,
  description: header.description.default(null),
  payee: header.payee.default(null),
  memo: header.memo.default(null),
});

/** No defaults here: an absent field is "leave it alone", not "set it to null". */
const EntryHeaderPatch = z.object(header).partial();

/**
 * The simple form is sugar: `amountMinor` is the signed amount posted to
 * `accountId`, and the category line is its exact negation. The service
 * desugars it into the explicit form rather than taking a second write path.
 * `projectId` lands on the category line, the only one it is meaningful on.
 */
const simpleLines = {
  accountId: Uuid,
  categoryId: Uuid,
  amountMinor: MinorUnits.refine((v) => v !== 0n, 'must not be zero'),
  projectId: Uuid.nullable().default(null),
};

export const CreateEntrySimple = EntryHeaderInput.extend(simpleLines);
export type CreateEntrySimple = z.infer<typeof CreateEntrySimple>;

/**
 * The zero-sum check is duplicated here so a split can be rejected in the form
 * before it is sent. The deferrable constraint trigger remains the authority.
 */
export const CreateEntryExplicit = EntryHeaderInput.extend({
  lines: z.array(EntryLineInput).min(2),
}).refine((entry) => sumsToZero(entry.lines), {
  message: 'lines must sum to zero',
  path: ['lines'],
});
export type CreateEntryExplicit = z.infer<typeof CreateEntryExplicit>;

export const CreateEntryRequest = z.union([
  CreateEntryExplicit,
  CreateEntrySimple,
]);
export type CreateEntryRequest = z.infer<typeof CreateEntryRequest>;
export type CreateEntryRequestWire = z.input<typeof CreateEntryRequest>;

export const UpdateEntryRequest = EntryHeaderPatch.extend({
  lines: z.array(EntryLineInput).min(2).optional(),
})
  .refine((patch) => Object.keys(patch).length > 0, 'nothing to change')
  .refine((patch) => patch.lines === undefined || sumsToZero(patch.lines), {
    message: 'lines must sum to zero',
    path: ['lines'],
  });
export type UpdateEntryRequest = z.infer<typeof UpdateEntryRequest>;
export type UpdateEntryRequestWire = z.input<typeof UpdateEntryRequest>;

/**
 * A correction carries no date. Both the reversal and the replacement are
 * dated today by definition — reaching back into a filed period is the thing
 * locking exists to prevent — so there is no date here for a caller to get
 * wrong, and none for the server to silently override.
 */
const CorrectionHeader = z.object({
  description: header.description.default(null),
  payee: header.payee.default(null),
  memo: header.memo.default(null),
});

export const CorrectionReplacementSimple = CorrectionHeader.extend(simpleLines);

export const CorrectionReplacementExplicit = CorrectionHeader.extend({
  lines: z.array(EntryLineInput).min(2),
}).refine((entry) => sumsToZero(entry.lines), {
  message: 'lines must sum to zero',
  path: ['lines'],
});

export const CorrectionReplacement = z.union([
  CorrectionReplacementExplicit,
  CorrectionReplacementSimple,
]);
export type CorrectionReplacement = z.infer<typeof CorrectionReplacement>;
export type CorrectionReplacementWire = z.input<typeof CorrectionReplacement>;

export const CreateCorrectionRequest = z.object({
  replacement: CorrectionReplacement,
});
export type CreateCorrectionRequest = z.infer<typeof CreateCorrectionRequest>;

export const CorrectionResponse = z.object({
  original: Entry,
  reversal: Entry,
  replacement: Entry,
});
export type CorrectionResponse = z.infer<typeof CorrectionResponse>;
export type CorrectionResponseWire = z.input<typeof CorrectionResponse>;

/** The 409 a locked entry returns. `lockedAt` is what the dialog renders. */
export const LockedEntryProblem = ProblemDetails.extend({
  status: z.literal(409),
  lockedAt: Timestamp,
  correction: z.string(),
});
export type LockedEntryProblem = z.infer<typeof LockedEntryProblem>;

/**
 * The 409 from correcting an entry a second time. A second reversal would
 * negate the original twice; the problem names the reversal already posted and
 * links to it, so the client can open it rather than retry.
 */
export const EntryAlreadyCorrectedProblem = ProblemDetails.extend({
  status: z.literal(409),
  reversedByEntryId: Uuid,
  reversal: z.string(),
});
export type EntryAlreadyCorrectedProblem = z.infer<typeof EntryAlreadyCorrectedProblem>;

export const SPLIT_LABEL = '—Split—' as const;

/**
 * A register row is an entry seen from one account: that account's line, with
 * the counter-side collapsed. One counter line shows itself; more than one
 * collapses to {@link SPLIT_LABEL} and opens the split detail.
 */
export const RowCounterparty = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('single'),
    ledgerAccountId: Uuid,
    name: z.string(),
    ledgerAccountKind: LedgerAccountKind,
    projectId: Uuid.nullable(),
    excludedFromReporting: z.boolean(),
  }),
  z.object({ kind: z.literal('split') }),
]);
export type RowCounterparty = z.infer<typeof RowCounterparty>;

export const TransactionRowView = z.object({
  entryId: Uuid,
  lineId: Uuid,
  occurredOn: CalendarDate,
  payee: z.string().nullable(),
  description: z.string().nullable(),
  /** Already carries its display sign. Nothing downstream flips it again. */
  amountMinor: MinorUnits,
  lockedAt: Timestamp.nullable(),
  reconciledAt: Timestamp.nullable(),
  counterparty: RowCounterparty,
  reverses: EntryRef.nullable(),
  reversedBy: EntryRef.nullable(),
  replaces: EntryRef.nullable(),
  /**
   * Present only when the register is filtered by project: the raw signed sum
   * of this entry's lines assigned to the project, so a $230 split carrying
   * $200 of it reads 200.00 beside the account's −230.00. Optional rather
   * than nullable because outside a project filter the share does not exist;
   * absence says that, where null would claim a value that is missing.
   */
  projectShareMinor: MinorUnits.optional(),
});
export type TransactionRowView = z.infer<typeof TransactionRowView>;
export type TransactionRowViewWire = z.input<typeof TransactionRowView>;

/**
 * `projectId` keeps the entries with at least one line on that project. Another
 * owner's project matches nothing, so it answers an empty page rather than a
 * 404 that would confirm the project exists.
 */
export const EntryListQuery = PageQuery.extend({
  accountId: Uuid,
  projectId: Uuid.optional(),
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
  q: z.string().trim().min(1).max(120).optional(),
});
export type EntryListQuery = z.infer<typeof EntryListQuery>;

/**
 * `projectEntriesInOtherAccounts` is present only under a project filter: the
 * project's entries with no line on this account, which the register cannot
 * show because it is account-scoped. The count follows the register's date
 * range — `from` and `to` apply to it, the payee search and cursor do not — so
 * it describes the same period as the rows beside it. Same on every page of
 * one listing.
 * Absent, not null, without the filter: the figure has no meaning there.
 */
export const TransactionPage = page(TransactionRowView).extend({
  projectEntriesInOtherAccounts: z.number().int().nonnegative().optional(),
});
export type TransactionPage = z.infer<typeof TransactionPage>;
export type TransactionPageWire = z.input<typeof TransactionPage>;

export const EntryIdParam = z.object({ id: Uuid });
