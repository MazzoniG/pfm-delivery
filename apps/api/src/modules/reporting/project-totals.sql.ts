import { Prisma } from '@prisma/client';
import { CalendarDate, MinorUnits, Uuid } from '@pfm/contracts';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';

export const ProjectTotalsRow = z.object({
  id: Uuid,
  name: z.string(),
  createdAt: z.date(),
  netCostMinor: MinorUnits,
  transactionCount: z.number().int(),
  firstActivityOn: CalendarDate.nullable(),
  lastActivityOn: CalendarDate.nullable(),
});
export type ProjectTotalsRow = z.infer<typeof ProjectTotalsRow>;

/**
 * Per project: net cost, the entries behind it, and the span they cover.
 *
 * Net cost is `SUM(amount_minor)` with no sign logic. A project's lines sit
 * only on income and expense accounts, so an expense (debit, positive) adds to
 * it and a refund booked to the project as income (credit, negative) takes
 * away — the same reason net worth is a plain sum.
 *
 * Driven from `projects` with the lines `LEFT JOIN`ed on, so a project with
 * nothing assigned still appears, at zero with null dates. Excluded lines are
 * out of every figure, as in the category report. Owner is stated on
 * `projects`, `entries` and `ledger_accounts`, and `kind` is constrained.
 */
export const projectTotalsSql = (ownerId: string, projectId?: string): Prisma.Sql => Prisma.sql`
  SELECT
    p.id AS "id",
    p.name AS "name",
    p.created_at AS "createdAt",
    COALESCE(SUM(t.amount_minor), 0)::text AS "netCostMinor",
    COUNT(DISTINCT t.entry_id)::int AS "transactionCount",
    to_char(MIN(t.occurred_on), 'YYYY-MM-DD') AS "firstActivityOn",
    to_char(MAX(t.occurred_on), 'YYYY-MM-DD') AS "lastActivityOn"
  FROM projects p
  LEFT JOIN (
    SELECT l.project_id, l.entry_id, l.amount_minor, e.occurred_on
    FROM entry_lines l
    JOIN entries e ON e.id = l.entry_id
    JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.owner_id = ${ownerId}::uuid
      AND a.owner_id = ${ownerId}::uuid
      AND a.kind IN ('income', 'expense')
      AND l.project_id IS NOT NULL
      AND l.excluded_from_reporting = false
  ) t ON t.project_id = p.id
  WHERE p.owner_id = ${ownerId}::uuid
    ${projectId ? Prisma.sql`AND p.id = ${projectId}::uuid` : Prisma.empty}
  GROUP BY p.id
  ORDER BY MAX(t.occurred_on) DESC NULLS LAST, p.created_at DESC, p.id
`;

export const selectProjectTotals = async (
  db: Db,
  ownerId: string,
  projectId?: string,
): Promise<ProjectTotalsRow[]> =>
  ProjectTotalsRow.array().parse(await db.$queryRaw(projectTotalsSql(ownerId, projectId)));
