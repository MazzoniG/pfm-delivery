import { Prisma } from '@prisma/client';
import {
  CalendarDate,
  MinorUnits,
  REPEAT_FREQUENCIES,
  Uuid,
} from '@pfm/contracts';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';

/**
 * A day on which net worth moved, and by how much. The one row with a null
 * `on` is the opening balance: everything that happened strictly before the
 * window, folded into a single figure so the running total is exact without
 * dragging the whole ledger back through the query.
 */
export const LedgerDeltaRow = z.object({
  on: CalendarDate.nullable(),
  deltaMinor: MinorUnits,
});
export type LedgerDeltaRow = z.infer<typeof LedgerDeltaRow>;

/**
 * Net worth is the raw signed sum over asset and liability lines, never
 * sign-flipped — the same definition `balances.sql.ts` rolls up, and the same
 * basis every figure in the projection is quoted in.
 *
 * `excluded_from_reporting` is deliberately not consulted, as in balance: an
 * excluded line still moved real money. The category report is where the flag
 * is honoured.
 *
 * Aggregated per day rather than per entry, because the chart plots a balance
 * on a date and two entries on the same day are one point.
 */
export const ledgerDeltasSql = (
  ownerId: string,
  from: string,
  to: string,
): Prisma.Sql => Prisma.sql`
  WITH scoped AS (
    SELECT e.occurred_on AS changed_on, l.amount_minor
    FROM entry_lines l
    JOIN entries e
      ON e.id = l.entry_id
     AND e.owner_id = ${ownerId}::uuid
    JOIN ledger_accounts a
      ON a.id = l.ledger_account_id
     AND a.owner_id = ${ownerId}::uuid
     AND a.kind IN ('asset', 'liability')
    WHERE e.occurred_on <= ${to}::date
  )
  SELECT
    NULL::text AS "on",
    COALESCE(SUM(amount_minor), 0)::text AS "deltaMinor"
  FROM scoped
  WHERE changed_on < ${from}::date
  UNION ALL
  SELECT
    to_char(changed_on, 'YYYY-MM-DD') AS "on",
    SUM(amount_minor)::text AS "deltaMinor"
  FROM scoped
  WHERE changed_on >= ${from}::date
  GROUP BY changed_on
  ORDER BY 1 NULLS FIRST
`;

export const ProjectionOccurrenceRow = z.object({
  id: Uuid,
  seriesId: Uuid,
  dueOn: CalendarDate,
  amountMinor: MinorUnits,
  payee: z.string(),
  frequency: z.enum(REPEAT_FREQUENCIES),
  dayOfMonth: z.number().int().nullable(),
  ledgerAccountId: Uuid,
  ledgerAccountName: z.string(),
  categoryId: Uuid,
  categoryName: z.string(),
});
export type ProjectionOccurrenceRow = z.infer<typeof ProjectionOccurrenceRow>;

/**
 * The unpaid scheduled bills and income up to `to`, with the names the list
 * renders. The caller splits them into overdue and scheduled on `due_on`
 * against today; this query does not know what today is.
 *
 * **`materialized_entry_id IS NULL` is the whole defence against double
 * counting.** A paid bill's money is in the ledger, where the balance half of
 * the projection already counts it, so counting the occurrence too would spend
 * it twice. That single predicate is what makes paying a bill leave the
 * projected total unchanged.
 *
 * Both joins on `ledger_accounts` constrain `kind`, and to opposite halves of
 * the chart: a series funds from an account and books to a category, and a row
 * where that is not true is corruption rather than a case to render.
 *
 * `frequency::text` comes back as the contract's own wire value — the enum
 * labels were chosen to match, so no translation table sits in the read path.
 */
export const projectionOccurrencesSql = (
  ownerId: string,
  to: string,
): Prisma.Sql => Prisma.sql`
  SELECT
    o.id AS "id",
    o.series_id AS "seriesId",
    to_char(o.due_on, 'YYYY-MM-DD') AS "dueOn",
    o.amount_minor::text AS "amountMinor",
    s.payee AS "payee",
    s.frequency::text AS "frequency",
    s.day_of_month::int AS "dayOfMonth",
    s.ledger_account_id AS "ledgerAccountId",
    acc.name AS "ledgerAccountName",
    s.category_id AS "categoryId",
    cat.name AS "categoryName"
  FROM scheduled_occurrences o
  JOIN recurring_series s
    ON s.id = o.series_id
   AND s.owner_id = ${ownerId}::uuid
  JOIN ledger_accounts acc
    ON acc.id = s.ledger_account_id
   AND acc.owner_id = ${ownerId}::uuid
   AND acc.kind IN ('asset', 'liability')
  JOIN ledger_accounts cat
    ON cat.id = s.category_id
   AND cat.owner_id = ${ownerId}::uuid
   AND cat.kind IN ('income', 'expense')
  WHERE o.materialized_entry_id IS NULL
    AND o.due_on <= ${to}::date
  ORDER BY o.due_on, o.id
`;

export const selectLedgerDeltas = async (
  db: Db,
  ownerId: string,
  from: string,
  to: string,
): Promise<LedgerDeltaRow[]> =>
  LedgerDeltaRow.array().parse(
    await db.$queryRaw(ledgerDeltasSql(ownerId, from, to)),
  );

export const selectProjectionOccurrences = async (
  db: Db,
  ownerId: string,
  to: string,
): Promise<ProjectionOccurrenceRow[]> =>
  ProjectionOccurrenceRow.array().parse(
    await db.$queryRaw(projectionOccurrencesSql(ownerId, to)),
  );
