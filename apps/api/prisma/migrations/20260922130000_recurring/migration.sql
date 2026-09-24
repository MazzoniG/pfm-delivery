-- US4 — future bills and income.
--
-- The rule this migration exists to make structural: **a scheduled occurrence
-- is not an entry.** It has not happened. Nothing here touches `entries` or
-- `entry_lines` except `scheduled_occurrences.materialized_entry_id`, which is
-- the single point at which a schedule becomes a transaction, and which is what
-- keeps the projection from counting the same money twice.
--
-- Additive: no applied migration is edited, no existing column changes, and
-- every balance, register and report query keeps reading exactly the tables it
-- read before this ran.

-- The four rule shapes, in the database as well as in the contract. There is no
-- `interval` column: an open interval would admit a fifth shape by arithmetic,
-- and the expansion code would then owe an answer to questions this story never
-- asks. Biweekly is its own value for that reason.
-- CreateEnum
CREATE TYPE "recurrence_frequency" AS ENUM ('one-off', 'weekly', 'biweekly', 'monthly');

-- `amount_minor` is the signed amount posted to `ledger_account_id` — the asset
-- or liability side — and `category_id` takes its exact negation when the bill
-- is paid. So a bill is negative and income positive, which is also the sign of
-- its effect on net worth, which is what the projection reports.
--
-- Two FKs into `ledger_accounts` because one entry has two sides. Neither can
-- be constrained to a `kind` here — a CHECK cannot read another table — so the
-- service enforces `asset | liability` for the account and `income | expense`
-- for the category, exactly as it does for an entry's lines.
--
-- `materialized_through` is the expansion watermark: occurrences exist up to
-- this date and no further. It is NULL until the series is first expanded, and
-- it is why a projection two years out does not write two years of rows.
-- CreateTable
CREATE TABLE "recurring_series" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "owner_id" UUID NOT NULL,
    "payee" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "ledger_account_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "frequency" "recurrence_frequency" NOT NULL,
    "day_of_month" SMALLINT,
    "first_due_on" DATE NOT NULL,
    "ends_on" DATE,
    "materialized_through" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_series_pkey" PRIMARY KEY ("id")
);

-- No `owner_id`, for the same reason `entry_lines` has none: an occurrence
-- inherits scope from its series, and a second copy is a consistency risk for
-- no gain. Owner-scoped queries over occurrences join through `recurring_series`.
--
-- `materialized_entry_id` is the only reference from this table into the
-- ledger, and it points at `entries` — there is no path from here to
-- `entry_lines` at all.
-- CreateTable
CREATE TABLE "scheduled_occurrences" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "series_id" UUID NOT NULL,
    "due_on" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "materialized_entry_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_series_owner_id_idx" ON "recurring_series"("owner_id");

-- Expansion is idempotent because the database says so, not because the code
-- remembers to check: re-expanding the same horizon collides here rather than
-- silently doubling a month's rent in the forecast.
-- CreateIndex
CREATE UNIQUE INDEX "scheduled_occurrences_series_id_due_on_key" ON "scheduled_occurrences"("series_id", "due_on");

-- One entry materialises at most one occurrence. Without this, the same payment
-- could be linked to two bills, and both would leave the projection on the
-- strength of one real transaction.
-- CreateIndex
CREATE UNIQUE INDEX "scheduled_occurrences_materialized_entry_id_key" ON "scheduled_occurrences"("materialized_entry_id") WHERE "materialized_entry_id" IS NOT NULL;

-- The projection reads exactly this set: unmaterialised occurrences, by date.
-- Materialised ones are dead weight in that scan and the partial index drops
-- them, so the index shrinks as bills are paid rather than growing forever.
-- CreateIndex
CREATE INDEX "scheduled_occurrences_due_on_unpaid_idx" ON "scheduled_occurrences"("due_on") WHERE "materialized_entry_id" IS NULL;

-- A zero occurrence is not a bill, matching the same rule on `entry_lines`.
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_amount_minor_nonzero" CHECK ("amount_minor" <> 0);
ALTER TABLE "scheduled_occurrences" ADD CONSTRAINT "scheduled_occurrences_amount_minor_nonzero" CHECK ("amount_minor" <> 0);

-- The anchor day belongs to `monthly` and to nothing else — the four shapes are
-- four shapes here too, not a wider table the contract happens to narrow.
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_day_of_month_monthly_only"
  CHECK (("frequency" = 'monthly') = ("day_of_month" IS NOT NULL));

ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_day_of_month_range"
  CHECK ("day_of_month" IS NULL OR "day_of_month" BETWEEN 1 AND 31);

-- A series that ends before it starts expands to nothing and is a data-entry
-- error, not a valid schedule.
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_ends_on_after_first_due"
  CHECK ("ends_on" IS NULL OR "ends_on" >= "first_due_on");

-- Both sides of the entry this series will post must be different accounts, or
-- paying it would produce a transaction that moves money to itself.
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_sides_differ"
  CHECK ("ledger_account_id" <> "category_id");

-- AddForeignKey
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Deleting a series takes its unpaid occurrences with it — they were never
-- anything but a projection of the rule. The entries it already materialised
-- are untouched: those are transactions, and they are the ledger's.
-- AddForeignKey
ALTER TABLE "scheduled_occurrences" ADD CONSTRAINT "scheduled_occurrences_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "recurring_series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ON DELETE SET NULL, deliberately, and it is the one place the link runs
-- backwards: if the entry that paid a bill is deleted, the money did not move
-- after all, so the occurrence becomes unpaid again and returns to the
-- projection. RESTRICT would let a schedule veto a deletion in the ledger, and
-- CASCADE would delete the bill because the payment was undone.
-- AddForeignKey
ALTER TABLE "scheduled_occurrences" ADD CONSTRAINT "scheduled_occurrences_materialized_entry_id_fkey" FOREIGN KEY ("materialized_entry_id") REFERENCES "entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
