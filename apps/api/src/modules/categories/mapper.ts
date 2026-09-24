import type { Category } from '@pfm/contracts';
import type { CategoryRow } from './repository.js';

export const toCategory = (row: CategoryRow): Category => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  isSystem: row.isSystem,
  archivedAt: row.archivedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});
