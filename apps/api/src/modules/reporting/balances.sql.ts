import { Prisma } from '@prisma/client';
import { AccountKind, MinorUnits, Uuid } from '@pfm/contracts';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';

/**
 * `account` rows carry a kind and an id, `kind` rows only a kind, and the
 * single `total` row neither — the three grouping sets `ROLLUP` emits, named so
 * the caller partitions on a word rather than on which columns came back null.
 */
export const BalanceLevel = z.enum(['account', 'kind', 'total']);
export type BalanceLevel = z.infer<typeof BalanceLevel>;

export const BalanceRow = z.object({
  level: BalanceLevel,
  kind: AccountKind.nullable(),
  ledgerAccountId: Uuid.nullable(),
  /** Only an account row has an archived flag; the rollup levels span both. */
  archived: z.boolean().nullable(),
  /**
   * A string on the way in, because the cast to text happens in the SQL: `SUM`
   * over `BIGINT` is `NUMERIC`, which the raw client hands back as a `Decimal`
   * and would round through a float if it ever reached one.
   */
  balanceMinor: MinorUnits,
});
export type BalanceRow = z.infer<typeof BalanceRow>;

/**
 * Every balance in the app: per account, per kind, and the grand total, which
 * is net worth. Raw signed sums throughout — `displaySign(kind)` is the
 * mapper's, and this query is the same for a chequing account and a credit
 * card, with no branch on direction.
 *
 * Driven from `ledger_accounts` so an account with no activity still answers
 * `0` instead of vanishing. That is also why the owner and date predicates over
 * `entries` sit in the join condition: in the `WHERE` clause they would reject
 * the all-null row an outer join produces and take those accounts with them.
 *
 * `excluded_from_reporting` is deliberately not consulted. An excluded line
 * still moved real money, so it belongs in a balance; the category report is
 * where the flag is honoured.
 *
 * Rides `entries (owner_id, occurred_on DESC, id DESC)` and
 * `entry_lines (ledger_account_id, entry_id)` — the pair that stands in for the
 * covering index this schema cannot have, since the columns are split across
 * the two tables.
 */
export const balancesSql = (ownerId: string, asOf: string): Prisma.Sql => Prisma.sql`
  SELECT
    CASE GROUPING(a.kind, a.id)
      WHEN 0 THEN 'account'
      WHEN 1 THEN 'kind'
      ELSE 'total'
    END AS "level",
    a.kind::text AS "kind",
    a.id AS "ledgerAccountId",
    CASE WHEN GROUPING(a.id) = 0 THEN bool_or(a.archived_at IS NOT NULL) END AS "archived",
    COALESCE(SUM(l.amount_minor), 0)::text AS "balanceMinor"
  FROM ledger_accounts a
  LEFT JOIN (
    entry_lines l
    JOIN entries e
      ON e.id = l.entry_id
     AND e.owner_id = ${ownerId}::uuid
     AND e.occurred_on <= ${asOf}::date
  ) ON l.ledger_account_id = a.id
  WHERE a.owner_id = ${ownerId}::uuid
    AND a.kind IN ('asset', 'liability')
  GROUP BY ROLLUP (a.kind, a.id)
  ORDER BY GROUPING(a.kind, a.id), a.kind, a.id
`;

/**
 * Archived accounts are included, every one of them: hiding them is a display
 * choice and `archived` carries it, but their money is still on the balance
 * sheet and still in net worth.
 *
 * A kind with no accounts produces no subtotal row — `ROLLUP` groups what it is
 * given — so a caller building the two-key subtotal shape defaults a missing
 * kind to zero. The grand total row is always present.
 */
export const selectBalances = async (
  db: Db,
  ownerId: string,
  asOf: string,
): Promise<BalanceRow[]> =>
  BalanceRow.array().parse(await db.$queryRaw(balancesSql(ownerId, asOf)));
