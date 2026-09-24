-- US1 — the ledger baseline.
--
-- The tables are Prisma's; everything below the DDL is not. The invariants this
-- model depends on — an entry exists only as a balanced set of lines, a
-- reconciled entry is frozen, and every change to an entry or its lines is
-- recorded — are enforced by triggers here rather than by the service layer, so
-- a raw SQL update, a later migration, or a developer bypassing the repository
-- is held to them too.
--
-- `projects` ships in this baseline rather than with US5 because
-- `entry_lines.project_id` is an FK into it. Splitting the two across
-- migrations would ship a window in which the column has no referent.
--
-- No rows are created here. A migration runs before any user exists, so the
-- per-user `Equity:Opening Balances` account cannot be created in one, and a
-- single global row would be exactly the cross-owner leak that `owner_id`
-- exists to prevent. System accounts are created per user, with the user.

-- CreateEnum
CREATE TYPE "ledger_account_kind" AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ledger_account_kind" NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- There is no `status` column. An entry is reversed when another entry's
-- `reverses_entry_id` points at it, and replaced when another's
-- `replaces_entry_id` does. Deriving both from the correction itself means
-- there is no second copy of the fact to fall out of step with the first, and
-- no write to a reconciled row is ever needed to record one.
-- CreateTable
CREATE TABLE "entries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "owner_id" UUID NOT NULL,
    "occurred_on" DATE NOT NULL,
    "description" TEXT,
    "payee" TEXT,
    "memo" TEXT,
    "locked_at" TIMESTAMPTZ(6),
    "reverses_entry_id" UUID,
    "replaces_entry_id" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entries_pkey" PRIMARY KEY ("id")
);

-- `entry_lines` carries no `owner_id`: it inherits scope from its entry, and a
-- second copy would be a consistency risk for no gain. Owner-scoped queries
-- over lines join through `entries`.
-- CreateTable
CREATE TABLE "entry_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "entry_id" UUID NOT NULL,
    "ledger_account_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "project_id" UUID,
    "excluded_from_reporting" BOOLEAN NOT NULL DEFAULT false,
    "reconciled_at" TIMESTAMPTZ(6),

    CONSTRAINT "entry_lines_pkey" PRIMARY KEY ("id")
);

-- `entry_audit_log` has neither an `owner_id` nor an FK on `entry_id`, and
-- both absences are deliberate rather than forgotten.
--
-- The log is written by AFTER triggers, so its DELETE rows outlive the entry
-- they describe. An FK would force a choice between ON DELETE CASCADE, which
-- destroys the evidence the log exists to preserve at the exact moment it
-- becomes interesting, and ON DELETE RESTRICT, which lets the log veto the
-- deletions it is supposed to be silently observing. A log of record does not
-- take a referential dependency on the thing it records.
--
-- Consequence, accepted: an owner-scoped audit query joins through `entries`,
-- so rows whose entry is gone are reachable only by direct id. This table is
-- the one documented exception to owner scoping — not an unscoped query, an
-- unscoped table.
--
-- Rows come from two tables and `source_table` says which, because `entry_id`
-- alone cannot distinguish "the payee was corrected" from "the amount was".
-- The id is a BIGSERIAL rather than a UUID so that rows written inside one
-- transaction, which share a `changed_at`, still have a total order.
-- CreateTable
CREATE TABLE "entry_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "entry_id" UUID NOT NULL,
    "source_table" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" UUID,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "before" JSONB,
    "after" JSONB,

    CONSTRAINT "entry_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_accounts_owner_id_kind_idx" ON "ledger_accounts"("owner_id", "kind");

-- Accounts are archived, never deleted, so uniqueness applies to live names
-- only: archiving "Everyday Checking" must leave the name free for its
-- replacement, while the archived row keeps its own name in history. Prisma
-- cannot express a filtered unique index, so this one is declared here and
-- `schema.prisma` carries a note where the `@@unique` would otherwise sit.
-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_owner_id_name_live_key" ON "ledger_accounts"("owner_id", "name") WHERE "archived_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "projects_owner_id_name_key" ON "projects"("owner_id", "name");

-- Keyset pagination reads this index directly: (owner_id, occurred_on DESC,
-- id DESC) is the register's sort order, and date-range filters ride the same
-- one. There is no offset anywhere in this codebase.
-- CreateIndex
CREATE INDEX "entries_owner_id_occurred_on_id_idx" ON "entries"("owner_id", "occurred_on" DESC, "id" DESC);

-- Both directions of a correction are read from these: the reversal's badge
-- follows `reverses_entry_id` forward, the original's follows it backward.
-- CreateIndex
CREATE INDEX "entries_reverses_entry_id_idx" ON "entries"("reverses_entry_id");

-- CreateIndex
CREATE INDEX "entries_replaces_entry_id_idx" ON "entries"("replaces_entry_id");

-- CreateIndex
CREATE INDEX "entry_lines_entry_id_idx" ON "entry_lines"("entry_id");

-- Balance and category rollups reach lines by account and join back to
-- `entries` for the owner and the date. A single covering index on (owner_id,
-- ledger_account_id, occurred_on) is not available: `owner_id` and
-- `occurred_on` live on `entries`, `ledger_account_id` and `amount_minor` on
-- `entry_lines`, and keeping the first two on lines as well is the duplication
-- this schema deliberately refuses. The pair below is that index, split across
-- the two tables the join already visits.
-- CreateIndex
CREATE INDEX "entry_lines_ledger_account_id_entry_id_idx" ON "entry_lines"("ledger_account_id", "entry_id");

-- CreateIndex
CREATE INDEX "entry_audit_log_entry_id_changed_at_idx" ON "entry_audit_log"("entry_id", "changed_at");

-- A zero line is not a posting. It carries no money, it cannot be the reason an
-- entry balances, and it would let an "entry" of nothing but zeroes satisfy the
-- zero-sum rule. With this in place, sum = 0 implies at least two lines.
ALTER TABLE "entry_lines" ADD CONSTRAINT "entry_lines_amount_minor_nonzero" CHECK ("amount_minor" <> 0);

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_replaces_entry_id_fkey" FOREIGN KEY ("replaces_entry_id") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_lines" ADD CONSTRAINT "entry_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_lines" ADD CONSTRAINT "entry_lines_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_lines" ADD CONSTRAINT "entry_lines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- The invariants.
--
-- Two custom SQLSTATEs so the API maps these to HTTP by code rather than by
-- matching message text:
--   PFM01  an entry is not a balanced set of at least two lines
--   PFM02  a reconciled entry was changed outside the correction path
--
-- Each function reads its row through `to_jsonb` rather than by field, so the
-- same code serves triggers on `entries` and on `entry_lines` without caring
-- which row type it was handed.
-- ---------------------------------------------------------------------------

-- 1. An entry balances, and an entry with no lines is not an entry.
--
-- Deferred to commit because both legs of an entry are separate INSERTs: a
-- check that fired per statement would reject every entry on its first line.
-- DEFERRABLE INITIALLY DEFERRED fires once the transaction is complete, which
-- is the only moment at which "this entry balances" is a meaningful question.
--
-- It fires from `entries` as well as `entry_lines`, because the empty case has
-- no line to fire from: an entry inserted alone, or stripped of its lines, is
-- otherwise silently legal.
CREATE FUNCTION assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_data   jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  target     uuid   := COALESCE(row_data ->> 'entry_id', row_data ->> 'id')::uuid;
  line_count bigint;
  total      bigint;
BEGIN
  -- The entry may have been deleted in this transaction, taking its lines with
  -- it. An entry that no longer exists is not an unbalanced one.
  IF NOT EXISTS (SELECT 1 FROM entries WHERE id = target) THEN
    RETURN NULL;
  END IF;

  SELECT count(*), COALESCE(SUM(amount_minor), 0) INTO line_count, total
  FROM entry_lines WHERE entry_id = target;

  IF line_count = 0 THEN
    RAISE EXCEPTION 'entry % has no lines', target
      USING ERRCODE = 'PFM01';
  END IF;

  IF total <> 0 THEN
    RAISE EXCEPTION 'entry % is out of balance by % minor units', target, total
      USING ERRCODE = 'PFM01';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

CREATE CONSTRAINT TRIGGER entry_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON entry_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- 2. A reconciled entry is frozen — every column, every line, no exemptions.
-- BEFORE, so the write never happens.
--
-- Reconciling is ordered to need none: it writes `reconciled_at` onto the lines
-- first and sets `locked_at` on the entry last, so every write in that
-- transaction happens while the entry is still open. After it, the only way to
-- change anything is a correction, which writes new entries and never touches
-- this one — `reverses_entry_id` lives on the reversal, pointing back here.
CREATE FUNCTION reject_change_to_locked_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'entry % was reconciled at % and can only be changed by correction',
      OLD.id, OLD.locked_at USING ERRCODE = 'PFM02';
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER entries_reject_locked_change
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION reject_change_to_locked_entry();

-- The same lock, on the table that actually holds the money. Without this, the
-- guard above is bypassed by editing a locked entry's lines directly, and the
-- ledger's reconciled totals are only as safe as the service layer's memory.
-- A cascade from a deleted entry sees no parent row and passes through.
CREATE FUNCTION reject_change_to_locked_entry_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid := CASE TG_OP WHEN 'DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
  locked timestamptz;
BEGIN
  SELECT locked_at INTO locked FROM entries WHERE id = target;

  IF locked IS NOT NULL THEN
    RAISE EXCEPTION 'entry % was reconciled at % and its lines can only be changed by correction',
      target, locked USING ERRCODE = 'PFM02';
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER entry_lines_reject_locked_change
  BEFORE INSERT OR UPDATE OR DELETE ON entry_lines
  FOR EACH ROW EXECUTE FUNCTION reject_change_to_locked_entry_line();

-- 3. The audit log, over both tables. AFTER, because it records what happened:
-- a BEFORE trigger would log writes that a later trigger, a constraint or a
-- rollback rejects.
--
-- Lines are logged as well as entries. The amounts live on the lines, so a log
-- that watched only `entries` would record that a transaction was touched and
-- not that its money changed.
--
-- `actor_id` reads a session setting so the authentication seam has somewhere
-- to land; unset, it is null, which is the honest answer for a stub identity.
CREATE FUNCTION log_entry_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_before jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  row_after  jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  row_data   jsonb := COALESCE(row_after, row_before);
BEGIN
  INSERT INTO entry_audit_log (entry_id, source_table, action, actor_id, before, after)
  VALUES (
    COALESCE(row_data ->> 'entry_id', row_data ->> 'id')::uuid,
    TG_TABLE_NAME,
    TG_OP,
    NULLIF(current_setting('pfm.actor_id', true), '')::uuid,
    row_before,
    row_after
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER entries_audit
  AFTER INSERT OR UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION log_entry_change();

CREATE TRIGGER entry_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON entry_lines
  FOR EACH ROW EXECUTE FUNCTION log_entry_change();
