import type { LedgerAccount } from '@pfm/contracts';
import type { AccountRow } from './repository.js';

/**
 * No balance here. It arrives with US2, from the one query that owns it, and
 * computing it anywhere else would put a second definition of "balance" in the
 * codebase. The register header keeps an empty slot until then.
 */
export const toLedgerAccount = (row: AccountRow): LedgerAccount => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  currency: row.currency,
  isSystem: row.isSystem,
  archivedAt: row.archivedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});
