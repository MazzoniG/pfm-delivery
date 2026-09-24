import { Prisma } from '@prisma/client';
import { CategoryLine, MinorUnits, Uuid, YearMonth } from '@pfm/contracts';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';

/**
 * `month` rows carry the month's total and no category; `category` rows carry
 * one category's total within it; `period` rows, only when asked for, carry one
 * category's total over the whole period and no month. The grouping sets are
 * named, as in the balance query, so the caller partitions on a word.
 */
export const CategoryMonthRow = z.object({
  level: z.enum(['month', 'category', 'period']),
  month: YearMonth.nullable(),
  ledgerAccountId: Uuid.nullable(),
  name: z.string().nullable(),
  totalMinor: MinorUnits,
  includesCorrection: z.boolean(),
});
export type CategoryMonthRow = z.infer<typeof CategoryMonthRow>;

export type SpendingFilter = {
  from: string;
  to: string;
  projectId?: string | undefined;
};

export type SpendingOptions = { periodTotals?: boolean };

/**
 * Monthly spending per expense category, plus each month's total, in one pass.
 *
 * Months are bucketed on `occurred_on::timestamp` — `timestamp without time
 * zone` — never on a `timestamptz`. `date_trunc` over a `timestamptz` truncates
 * in the session's `TimeZone`, so with the session west of UTC an entry dated
 * the 1st would land in the previous month. A calendar date has no timezone,
 * and the bucket must not acquire one.
 *
 * Driven from a generated month series with the spending `LEFT JOIN`ed on, so
 * a month with nothing in it still returns its `month` row at zero. The
 * `(month, category)` grouping set produces a spurious all-null category row
 * for such a month, which the `HAVING` drops.
 *
 * Two mandatory predicates: owner, stated on both `entries` and
 * `ledger_accounts`, and `kind = 'expense'`. Excluded lines are left out here —
 * the mirror of the balance query, which counts them, because they moved real
 * money but were not the owner's spending. No `ABS()`: a correction posted in
 * a later month can legitimately make a category negative.
 *
 * `projectId` narrows it to one project's lines, and `periodTotals` adds the
 * per-category totals over the whole period as a third grouping set — the
 * project page's by-category table. Its rows sort after every month, because
 * their month is null.
 */
export const categoryMonthlySql = (
  ownerId: string,
  filter: SpendingFilter,
  { periodTotals = false }: SpendingOptions = {},
): Prisma.Sql => Prisma.sql`
  WITH months AS (
    SELECT m::date AS month
    FROM generate_series(
      date_trunc('month', ${filter.from}::date::timestamp),
      date_trunc('month', ${filter.to}::date::timestamp),
      interval '1 month'
    ) AS m
  ),
  spending AS (
    SELECT
      date_trunc('month', e.occurred_on::timestamp)::date AS month,
      a.id AS ledger_account_id,
      a.name,
      l.amount_minor,
      (e.reverses_entry_id IS NOT NULL OR e.replaces_entry_id IS NOT NULL) AS is_correction
    FROM entry_lines l
    JOIN entries e ON e.id = l.entry_id
    JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.owner_id = ${ownerId}::uuid
      AND a.owner_id = ${ownerId}::uuid
      AND a.kind = 'expense'
      AND l.excluded_from_reporting = false
      AND e.occurred_on BETWEEN ${filter.from}::date AND ${filter.to}::date
      ${filter.projectId ? Prisma.sql`AND l.project_id = ${filter.projectId}::uuid` : Prisma.empty}
  )
  SELECT
    CASE
      WHEN GROUPING(m.month) = 1 THEN 'period'
      WHEN GROUPING(s.ledger_account_id) = 0 THEN 'category'
      ELSE 'month'
    END AS "level",
    to_char(m.month, 'YYYY-MM') AS "month",
    s.ledger_account_id AS "ledgerAccountId",
    s.name AS "name",
    COALESCE(SUM(s.amount_minor), 0)::text AS "totalMinor",
    COALESCE(bool_or(s.is_correction), false) AS "includesCorrection"
  FROM months m
  LEFT JOIN spending s ON s.month = m.month
  GROUP BY GROUPING SETS (
    (m.month),
    (m.month, s.ledger_account_id, s.name)
    ${periodTotals ? Prisma.sql`, (s.ledger_account_id, s.name)` : Prisma.empty}
  )
  HAVING GROUPING(s.ledger_account_id) = 1 OR s.ledger_account_id IS NOT NULL
  ORDER BY m.month, GROUPING(s.ledger_account_id) DESC, SUM(s.amount_minor) DESC, s.name
`;

export const selectCategoryMonthly = async (
  db: Db,
  ownerId: string,
  filter: SpendingFilter,
  options?: SpendingOptions,
): Promise<CategoryMonthRow[]> =>
  CategoryMonthRow.array().parse(
    await db.$queryRaw(categoryMonthlySql(ownerId, filter, options)),
  );

export type CategoryLineRow = CategoryLine;

/** The entry's asset and liability lines — the side the money came from. Reads `e`. */
export const fundingAccountsSql = (ownerId: string): Prisma.Sql => Prisma.sql`
  COALESCE((
    SELECT json_agg(json_build_object('ledgerAccountId', fa.id, 'name', fa.name) ORDER BY fa.name)
    FROM entry_lines fl
    JOIN ledger_accounts fa ON fa.id = fl.ledger_account_id
    WHERE fl.entry_id = e.id
      AND fa.owner_id = ${ownerId}::uuid
      AND fa.kind IN ('asset', 'liability')
  ), '[]'::json)
`;

/** `reverses`, `reversedBy` and `replaces` for the entry `e`, each lookup owner-scoped. */
export const correctionLinksSql = (ownerId: string): Prisma.Sql => Prisma.sql`
  (
    SELECT json_build_object('id', o.id, 'occurredOn', to_char(o.occurred_on, 'YYYY-MM-DD'))
    FROM entries o
    WHERE o.id = e.reverses_entry_id AND o.owner_id = ${ownerId}::uuid
  ) AS "reverses",
  (
    SELECT json_build_object('id', r.id, 'occurredOn', to_char(r.occurred_on, 'YYYY-MM-DD'))
    FROM entries r
    WHERE r.reverses_entry_id = e.id AND r.owner_id = ${ownerId}::uuid
    ORDER BY r.occurred_on, r.id
    LIMIT 1
  ) AS "reversedBy",
  (
    SELECT json_build_object('id', o.id, 'occurredOn', to_char(o.occurred_on, 'YYYY-MM-DD'))
    FROM entries o
    WHERE o.id = e.replaces_entry_id AND o.owner_id = ${ownerId}::uuid
  ) AS "replaces"
`;

/**
 * The lines behind one category's figure, under exactly the report's rules —
 * owner, `kind = 'expense'`, excluded lines out, the same period — so the rows
 * a user expands always add up to the total they clicked.
 *
 * `accounts` are the entry's asset and liability lines: the side the money
 * came from. The correction links are read in both directions as in the
 * register, each lookup scoped to the owner again rather than trusting that an
 * FK can only point within one.
 */
export const categoryLinesSql = (
  ownerId: string,
  ledgerAccountId: string,
  filter: SpendingFilter,
): Prisma.Sql => Prisma.sql`
  SELECT
    e.id AS "entryId",
    l.id AS "lineId",
    to_char(e.occurred_on, 'YYYY-MM-DD') AS "occurredOn",
    e.payee AS "payee",
    ${fundingAccountsSql(ownerId)} AS "accounts",
    l.amount_minor::text AS "amountMinor",
    ${correctionLinksSql(ownerId)}
  FROM entry_lines l
  JOIN entries e ON e.id = l.entry_id
  JOIN ledger_accounts a ON a.id = l.ledger_account_id
  WHERE e.owner_id = ${ownerId}::uuid
    AND a.owner_id = ${ownerId}::uuid
    AND a.kind = 'expense'
    AND a.id = ${ledgerAccountId}::uuid
    AND l.excluded_from_reporting = false
    AND e.occurred_on BETWEEN ${filter.from}::date AND ${filter.to}::date
  ORDER BY e.occurred_on DESC, e.id DESC, l.id
`;

export const selectCategoryLines = async (
  db: Db,
  ownerId: string,
  ledgerAccountId: string,
  filter: SpendingFilter,
): Promise<CategoryLineRow[]> =>
  CategoryLine.array().parse(
    await db.$queryRaw(categoryLinesSql(ownerId, ledgerAccountId, filter)),
  );

export const expenseCategoryExistsSql = (ownerId: string, ledgerAccountId: string): Prisma.Sql => Prisma.sql`
  SELECT EXISTS (
    SELECT 1 FROM ledger_accounts
    WHERE id = ${ledgerAccountId}::uuid
      AND owner_id = ${ownerId}::uuid
      AND kind = 'expense'
  ) AS "exists"
`;

export const expenseCategoryExists = async (
  db: Db,
  ownerId: string,
  ledgerAccountId: string,
): Promise<boolean> => {
  const [row] = z
    .object({ exists: z.boolean() })
    .array()
    .parse(await db.$queryRaw(expenseCategoryExistsSql(ownerId, ledgerAccountId)));
  return row?.exists ?? false;
};
