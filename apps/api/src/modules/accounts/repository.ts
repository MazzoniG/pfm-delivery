import { Prisma } from '@prisma/client';
import { ACCOUNT_KINDS, type AccountKind } from '@pfm/contracts';
import { ConflictError } from '../../shared/errors/app-error.js';
import type { Db } from '../../shared/db/prisma.js';

export type AccountRow = {
  id: string;
  name: string;
  kind: AccountKind;
  currency: string;
  isSystem: boolean;
  archivedAt: Date | null;
  createdAt: Date;
};

export type CreateAccount = {
  name: string;
  kind: AccountKind;
  currency: string;
};

export type AccountRepository = {
  listLive(ownerId: string): Promise<AccountRow[]>;
  findById(ownerId: string, id: string): Promise<AccountRow | null>;
  create(ownerId: string, input: CreateAccount): Promise<AccountRow>;
  rename(ownerId: string, id: string, name: string): Promise<AccountRow | null>;
  archive(ownerId: string, id: string, at: Date): Promise<boolean>;
};

const columns = {
  id: true,
  name: true,
  kind: true,
  currency: true,
  isSystem: true,
  archivedAt: true,
  createdAt: true,
} as const;

/**
 * Two predicates are mandatory on every query in this file and neither is
 * optional: `owner_id`, or the row belongs to someone else, and `kind`, or
 * `/accounts` starts serving categories. They are written once, here, so that
 * no method can remember one and forget the other.
 */
const scope = (ownerId: string) => ({
  ownerId,
  kind: { in: [...ACCOUNT_KINDS] },
});

type SelectedRow = Omit<AccountRow, 'kind'> & { kind: string };

/** Sound because `scope` constrains `kind`; the database knows, the types don't. */
const asAccount = (row: SelectedRow): AccountRow => row as AccountRow;

const isNameTaken = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

// The unique index is partial — live names only — so this fires exactly when
// another *unarchived* account already holds the name.
const rejectDuplicateName = async <T>(
  name: string,
  write: () => Promise<T>,
): Promise<T> => {
  try {
    return await write();
  } catch (error) {
    if (isNameTaken(error)) {
      throw new ConflictError(
        'Account name already in use',
        `An open account named "${name}" already exists.`,
      );
    }
    throw error;
  }
};

export const createAccountRepository = (db: Db): AccountRepository => {
  const findById: AccountRepository['findById'] = async (ownerId, id) => {
    const row = await db.ledgerAccount.findFirst({
      where: { ...scope(ownerId), id },
      select: columns,
    });
    return row ? asAccount(row) : null;
  };

  return {
    findById,

    listLive: async (ownerId) => {
      const rows = await db.ledgerAccount.findMany({
        where: { ...scope(ownerId), archivedAt: null },
        select: columns,
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      });
      return rows.map(asAccount);
    },

    create: (ownerId, input) =>
      rejectDuplicateName(input.name, async () => {
        const row = await db.ledgerAccount.create({
          data: { ownerId, ...input },
          select: columns,
        });
        return asAccount(row);
      }),

    rename: (ownerId, id, name) =>
      rejectDuplicateName(name, async () => {
        const { count } = await db.ledgerAccount.updateMany({
          where: { ...scope(ownerId), id, archivedAt: null },
          data: { name },
        });
        return count === 0 ? null : findById(ownerId, id);
      }),

    archive: async (ownerId, id, at) => {
      const { count } = await db.ledgerAccount.updateMany({
        where: { ...scope(ownerId), id, archivedAt: null },
        data: { archivedAt: at },
      });
      return count > 0;
    },
  };
};
