-- Unique: an entry is reversed at most once, or a second correction makes the
-- ledger count the original twice; the service maps a violation of this name to
-- 409. Partial: only reversals carry the column, and `reverses_entry_id = $1`
-- implies NOT NULL, so the backward correction lookup still uses it. Prisma
-- cannot express a filtered unique index, so `schema.prisma` carries a note
-- where the `@@unique` would sit.
DROP INDEX "entries_reverses_entry_id_idx";

CREATE UNIQUE INDEX "entries_reverses_entry_id_key" ON "entries"("reverses_entry_id") WHERE "reverses_entry_id" IS NOT NULL;
