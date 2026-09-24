import type { RecurrenceFrequency } from '@prisma/client';
import { ACCOUNT_KINDS, CATEGORY_KINDS, type LedgerAccountKind } from '@pfm/contracts';
import type { Db } from '../../shared/db/prisma.js';

export type SeriesRow = {
  id: string;
  payee: string;
  amountMinor: bigint;
  ledgerAccountId: string;
  categoryId: string;
  frequency: RecurrenceFrequency;
  dayOfMonth: number | null;
  firstDueOn: Date;
  endsOn: Date | null;
  materializedThrough: Date | null;
  createdAt: Date;
};

export type SeriesInput = {
  payee: string;
  amountMinor: bigint;
  ledgerAccountId: string;
  categoryId: string;
  frequency: RecurrenceFrequency;
  dayOfMonth: number | null;
  firstDueOn: Date;
  endsOn: Date | null;
};

export type OccurrenceRow = {
  id: string;
  seriesId: string;
  dueOn: Date;
  amountMinor: bigint;
  materializedEntryId: string | null;
};

/** An occurrence with the series fields the payment needs to post an entry. */
export type PayableOccurrence = OccurrenceRow & {
  series: { payee: string; categoryId: string; ledgerAccountId: string };
};

export type ReferencedAccount = { id: string; kind: LedgerAccountKind };

export type RecurringRepository = {
  createSeries(ownerId: string, input: SeriesInput): Promise<SeriesRow>;
  ownedAccounts(ownerId: string, ids: string[]): Promise<ReferencedAccount[]>;
  seriesToExpand(ownerId: string, horizon: Date): Promise<SeriesRow[]>;
  addOccurrences(
    rows: readonly Omit<OccurrenceRow, 'id' | 'materializedEntryId'>[],
  ): Promise<void>;
  advanceWatermark(
    ownerId: string,
    seriesIds: string[],
    horizon: Date,
  ): Promise<void>;
  findOccurrence(
    ownerId: string,
    id: string,
  ): Promise<PayableOccurrence | null>;
  linkEntry(
    ownerId: string,
    id: string,
    entryId: string,
  ): Promise<OccurrenceRow | null>;
};

const seriesColumns = {
  id: true,
  payee: true,
  amountMinor: true,
  ledgerAccountId: true,
  categoryId: true,
  frequency: true,
  dayOfMonth: true,
  firstDueOn: true,
  endsOn: true,
  materializedThrough: true,
  createdAt: true,
} as const;

const occurrenceColumns = {
  id: true,
  seriesId: true,
  dueOn: true,
  amountMinor: true,
  materializedEntryId: true,
} as const;

export const createRecurringRepository = (db: Db): RecurringRepository => ({
  createSeries: (ownerId, input) =>
    db.recurringSeries.create({
      data: { ownerId, ...input },
      select: seriesColumns,
    }),

  // A series names an account and a category, and never equity — so the
  // predicate is the two halves rather than the whole chart. The service holds
  // each side to its own half; this keeps the query from being able to return
  // a row that could only ever be refused.
  ownedAccounts: (ownerId, ids) =>
    db.ledgerAccount.findMany({
      where: {
        ownerId,
        id: { in: ids },
        kind: { in: [...ACCOUNT_KINDS, ...CATEGORY_KINDS] },
      },
      select: { id: true, kind: true },
    }),

  /**
   * Only the series that have something left to expand. One already
   * materialised to or past the horizon is skipped entirely, which is what
   * makes asking for the same horizon twice cost one query and no writes.
   */
  seriesToExpand: (ownerId, horizon) =>
    db.recurringSeries.findMany({
      where: {
        ownerId,
        firstDueOn: { lte: horizon },
        OR: [
          { materializedThrough: null },
          { materializedThrough: { lt: horizon } },
        ],
      },
      select: seriesColumns,
    }),

  // `skipDuplicates` leans on the (series_id, due_on) unique index, so two
  // concurrent expansions of the same window settle on one set of rows rather
  // than one of them failing.
  addOccurrences: async (rows) => {
    if (rows.length === 0) return;
    await db.scheduledOccurrence.createMany({
      data: [...rows],
      skipDuplicates: true,
    });
  },

  // Never backwards: a concurrent expansion to a further horizon must not be
  // undone by this one reporting a nearer one.
  advanceWatermark: async (ownerId, seriesIds, horizon) => {
    if (seriesIds.length === 0) return;
    await db.recurringSeries.updateMany({
      where: {
        ownerId,
        id: { in: seriesIds },
        OR: [
          { materializedThrough: null },
          { materializedThrough: { lt: horizon } },
        ],
      },
      data: { materializedThrough: horizon },
    });
  },

  // Scoped through the series, the same way every query over `entry_lines`
  // reaches its owner through `entries`.
  findOccurrence: (ownerId, id) =>
    db.scheduledOccurrence.findFirst({
      where: { id, series: { ownerId } },
      select: {
        ...occurrenceColumns,
        series: {
          select: { payee: true, categoryId: true, ledgerAccountId: true },
        },
      },
    }),

  /**
   * Returns null when the occurrence was already paid. The `materializedEntryId:
   * null` predicate is the claim: two callers paying the same bill at once both
   * post an entry, and exactly one of them links it.
   */
  linkEntry: async (ownerId, id, entryId) => {
    const { count } = await db.scheduledOccurrence.updateMany({
      where: { id, materializedEntryId: null, series: { ownerId } },
      data: { materializedEntryId: entryId },
    });
    if (count === 0) return null;
    return db.scheduledOccurrence.findFirst({
      where: { id, series: { ownerId } },
      select: occurrenceColumns,
    });
  },
});
