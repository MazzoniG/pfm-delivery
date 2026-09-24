import { CATEGORY_KINDS, type CategoryKind } from '@pfm/contracts';
import type { Db } from '../../shared/db/prisma.js';

export type CategoryRow = {
  id: string;
  name: string;
  kind: CategoryKind;
  isSystem: boolean;
  archivedAt: Date | null;
  createdAt: Date;
};

export type CategoryRepository = {
  listLive(ownerId: string, kind?: CategoryKind): Promise<CategoryRow[]>;
};

const columns = {
  id: true,
  name: true,
  kind: true,
  isSystem: true,
  archivedAt: true,
  createdAt: true,
} as const;

/** The other half of the same rule the accounts repository states. */
const scope = (ownerId: string, kind?: CategoryKind) => ({
  ownerId,
  kind: kind ? { in: [kind] } : { in: [...CATEGORY_KINDS] },
});

export const createCategoryRepository = (db: Db): CategoryRepository => ({
  listLive: async (ownerId, kind) => {
    const rows = await db.ledgerAccount.findMany({
      where: { ...scope(ownerId, kind), archivedAt: null },
      select: columns,
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
    return rows as CategoryRow[];
  },
});
