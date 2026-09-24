import { Prisma } from '@prisma/client';
import { LEDGER_ACCOUNT_KINDS, type Keyset, type LedgerAccountKind } from '@pfm/contracts';
import { guardLedgerWrite } from '../../shared/db/ledger-errors.js';
import type { Db } from '../../shared/db/prisma.js';

export type LineRow = {
  id: string;
  ledgerAccountId: string;
  amountMinor: bigint;
  projectId: string | null;
  excludedFromReporting: boolean;
  reconciledAt: Date | null;
  ledgerAccount: { id: string; name: string; kind: LedgerAccountKind };
};

export type EntryRow = {
  id: string;
  occurredOn: Date;
  description: string | null;
  payee: string | null;
  memo: string | null;
  lockedAt: Date | null;
  reversesEntryId: string | null;
  replacesEntryId: string | null;
  recordedAt: Date;
  lines: LineRow[];
  reverses: { id: string; occurredOn: Date } | null;
  replaces: { id: string; occurredOn: Date } | null;
  reversedBy: { id: string; occurredOn: Date }[];
};

export type LineInput = {
  ledgerAccountId: string;
  amountMinor: bigint;
  projectId: string | null;
  excludedFromReporting: boolean;
};

export type EntryInput = {
  occurredOn: Date;
  description: string | null;
  payee: string | null;
  memo: string | null;
  lines: LineInput[];
  reversesEntryId?: string;
  replacesEntryId?: string;
};

export type EntryPatch = {
  occurredOn?: Date;
  description?: string | null;
  payee?: string | null;
  memo?: string | null;
};

export type ListFilters = {
  ledgerAccountId: string;
  projectId?: string;
  from?: Date;
  to?: Date;
  payeeContains?: string;
  limit: number;
  cursor?: Keyset;
};

export type ElsewhereFilters = {
  projectId: string;
  ledgerAccountId: string;
  from?: Date;
  to?: Date;
};

export type CorrectOutcome =
  | { kind: 'written'; reversal: EntryRow; replacement: EntryRow }
  | { kind: 'already-reversed' };

export type ReferencedAccount = { id: string; kind: LedgerAccountKind };

export type EntryRepository = {
  page(ownerId: string, filters: ListFilters): Promise<EntryRow[]>;
  findById(ownerId: string, id: string): Promise<EntryRow | null>;
  create(ownerId: string, input: EntryInput): Promise<EntryRow>;
  update(ownerId: string, id: string, patch: EntryPatch, lines?: LineInput[]): Promise<EntryRow>;
  remove(ownerId: string, id: string): Promise<void>;
  correct(
    ownerId: string,
    reversal: EntryInput,
    replacement: EntryInput,
  ): Promise<CorrectOutcome>;
  ownedAccounts(ownerId: string, ids: string[]): Promise<ReferencedAccount[]>;
  ownedProjectIds(ownerId: string, ids: string[]): Promise<string[]>;
  countProjectEntriesElsewhere(ownerId: string, filters: ElsewhereFilters): Promise<number>;
};

const entryShape = {
  lines: {
    orderBy: { amountMinor: 'desc' },
    include: {
      ledgerAccount: { select: { id: true, name: true, kind: true } },
    },
  },
  reverses: { select: { id: true, occurredOn: true } },
  replaces: { select: { id: true, occurredOn: true } },
  reversedBy: { select: { id: true, occurredOn: true } },
} satisfies Prisma.EntryInclude;

const asCalendarDate = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * The one query in this module that is not Prisma's, and the reason is
 * measurable. Keyset paging needs `(occurred_on, id) < (cursor)` as a row-value
 * comparison, which Postgres turns into an `Index Cond` on
 * `(owner_id, occurred_on DESC, id DESC)` — the scan starts *at* the cursor.
 * Prisma can only express the same logic as `OR`, which the planner demotes to
 * a `Filter`: correct, but it walks and discards every row above the cursor,
 * so page 500 costs five hundred times page 1. That is the entire property
 * keyset pagination exists to buy.
 *
 * It returns ids only. The rows themselves come back through Prisma, so the
 * projection and its types stay in one place.
 */
const pageIds = (ownerId: string, filters: ListFilters): Prisma.Sql => {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`e.owner_id = ${ownerId}::uuid`,
    Prisma.sql`EXISTS (
      SELECT 1 FROM entry_lines l
      WHERE l.entry_id = e.id AND l.ledger_account_id = ${filters.ledgerAccountId}::uuid
    )`,
  ];

  if (filters.projectId) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM entry_lines l
      WHERE l.entry_id = e.id AND l.project_id = ${filters.projectId}::uuid
    )`);
  }
  if (filters.from) {
    conditions.push(Prisma.sql`e.occurred_on >= ${asCalendarDate(filters.from)}::date`);
  }
  if (filters.to) {
    conditions.push(Prisma.sql`e.occurred_on <= ${asCalendarDate(filters.to)}::date`);
  }
  if (filters.payeeContains) {
    conditions.push(Prisma.sql`e.payee ILIKE ${`%${filters.payeeContains}%`}`);
  }
  if (filters.cursor) {
    conditions.push(
      Prisma.sql`(e.occurred_on, e.id) < (${filters.cursor.occurredOn}::date, ${filters.cursor.id}::uuid)`,
    );
  }

  return Prisma.sql`
    SELECT e.id
    FROM entries e
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY e.occurred_on DESC, e.id DESC
    LIMIT ${filters.limit}
  `;
};

const SINGLE_REVERSAL_INDEX = 'entries_reverses_entry_id_key';

type UniqueViolation = {
  code?: string;
  meta?: {
    target?: unknown;
    driverAdapterError?: { cause?: { originalCode?: string; constraint?: { index?: string } } };
  };
};

// The race the service's `reversedBy` check cannot close: two corrections read
// the original before either commits, and the partial unique index refuses the
// second.
const isSecondReversal = (error: unknown): boolean => {
  const { code, meta } = (error ?? {}) as UniqueViolation;
  const cause = meta?.driverAdapterError?.cause;
  const unique = code === 'P2002' || cause?.originalCode === '23505';
  const target = meta?.target;
  const named =
    cause?.constraint?.index === SINGLE_REVERSAL_INDEX ||
    target === SINGLE_REVERSAL_INDEX ||
    (Array.isArray(target) && target.includes(SINGLE_REVERSAL_INDEX));
  return unique && named;
};

export const createEntryRepository = (db: Db): EntryRepository => {
  const findById: EntryRepository['findById'] = async (ownerId, id) =>
    (await db.entry.findFirst({
      where: { ownerId, id },
      include: entryShape,
    })) as EntryRow | null;

  const load = async (ownerId: string, id: string): Promise<EntryRow> => {
    const row = await findById(ownerId, id);
    if (!row) throw new Error(`entry ${id} vanished mid-transaction`);
    return row;
  };

  const writeEntry = async (
    tx: Prisma.TransactionClient,
    ownerId: string,
    input: EntryInput,
  ): Promise<string> => {
    const { lines, ...header } = input;
    const created = await tx.entry.create({
      data: { ownerId, ...header, lines: { create: lines } },
      select: { id: true },
    });
    return created.id;
  };

  return {
    findById,

    page: async (ownerId, filters) => {
      const ids = await db.$queryRaw<{ id: string }[]>(pageIds(ownerId, filters));
      if (ids.length === 0) return [];

      // Owner-scoped again on the way back: the id list came from an
      // owner-scoped query, and this one states it too rather than trusting it.
      const rows = await db.entry.findMany({
        where: { ownerId, id: { in: ids.map((row) => row.id) } },
        include: entryShape,
        orderBy: [{ occurredOn: 'desc' }, { id: 'desc' }],
      });
      return rows as EntryRow[];
    },

    create: async (ownerId, input) => {
      const id = await guardLedgerWrite(() =>
        db.$transaction((tx) => writeEntry(tx, ownerId, input)),
      );
      return load(ownerId, id);
    },

    update: async (ownerId, id, patch, lines) => {
      await guardLedgerWrite(() =>
        db.$transaction(async (tx) => {
          // Owner scoping decided by a WHERE clause, in the same transaction as
          // the writes it authorises. The service checks this too; a repository
          // that relies on the layer above it for scoping is one refactor away
          // from writing to another tenant's ledger.
          const mine = await tx.entry.findFirst({
            where: { id, ownerId },
            select: { id: true },
          });
          if (!mine) return;

          if (Object.keys(patch).length > 0) {
            await tx.entry.updateMany({ where: { id, ownerId }, data: patch });
          }
          if (lines) {
            // Replace wholesale. Between these two statements the entry has no
            // lines at all, which holds together only because the zero-sum
            // check is deferred to commit. The delete reaches the owner through
            // the entry, the same way every other query over lines does.
            await tx.entryLine.deleteMany({
              where: { entryId: id, entry: { ownerId } },
            });
            await tx.entryLine.createMany({
              data: lines.map((line) => ({ ...line, entryId: id })),
            });
          }
        }),
      );
      return load(ownerId, id);
    },

    remove: async (ownerId, id) => {
      await guardLedgerWrite(() =>
        db.entry.deleteMany({ where: { id, ownerId } }),
      );
    },

    // Reversal and replacement land together or not at all: a ledger holding a
    // reversal with no replacement is worse than one holding neither.
    correct: async (ownerId, reversal, replacement) => {
      let written: { reversalId: string; replacementId: string };
      try {
        written = await guardLedgerWrite(() =>
          db.$transaction(async (tx) => ({
            reversalId: await writeEntry(tx, ownerId, reversal),
            replacementId: await writeEntry(tx, ownerId, replacement),
          })),
        );
      } catch (error) {
        if (isSecondReversal(error)) return { kind: 'already-reversed' };
        throw error;
      }
      return {
        kind: 'written',
        reversal: await load(ownerId, written.reversalId),
        replacement: await load(ownerId, written.replacementId),
      };
    },

    // Unlike `/accounts` and `/categories`, a line may name any kind in the
    // chart — the bank side, the category side, and equity for an opening
    // balance. The predicate says so instead of being absent.
    ownedAccounts: (ownerId, ids) =>
      db.ledgerAccount.findMany({
        where: { ownerId, id: { in: ids }, kind: { in: [...LEDGER_ACCOUNT_KINDS] } },
        select: { id: true, kind: true },
      }),

    ownedProjectIds: async (ownerId, ids) => {
      const rows = await db.project.findMany({
        where: { ownerId, id: { in: ids } },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    },

    // The same date range as the page it annotates, but not the payee search or
    // the cursor: it says what the account-scoped register cannot show at all.
    countProjectEntriesElsewhere: (ownerId, { projectId, ledgerAccountId, from, to }) =>
      db.entry.count({
        where: {
          ownerId,
          lines: { some: { projectId } },
          NOT: { lines: { some: { ledgerAccountId } } },
          ...(from || to
            ? { occurredOn: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
            : {}),
        },
      }),
  };
};
