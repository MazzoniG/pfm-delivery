import { Prisma } from '@prisma/client';
import { MAX_PROJECT_REPORT_LINES, ProjectLine } from '@pfm/contracts';
import type { Db } from '../../shared/db/prisma.js';
import { correctionLinksSql, fundingAccountsSql } from './category-monthly.sql.js';

/**
 * A project's lines from the category side, under the totals query's rules —
 * owner, `kind IN ('income', 'expense')`, excluded lines out — so they add up
 * to the net cost whenever the list is not truncated.
 *
 * `entryTotalMinor` is the sum of the entry's income and expense lines, set
 * only when there is more than one of them: the $230 behind a $200 share. It
 * counts every such line, project or not and excluded or not, because it is
 * what the purchase came to.
 *
 * One row past the cap is fetched, so the caller can say the list was cut
 * without a second query to count it.
 */
export const projectLinesSql = (ownerId: string, projectId: string): Prisma.Sql => Prisma.sql`
  SELECT
    e.id AS "entryId",
    l.id AS "lineId",
    to_char(e.occurred_on, 'YYYY-MM-DD') AS "occurredOn",
    e.payee AS "payee",
    a.id AS "ledgerAccountId",
    a.name AS "categoryName",
    ${fundingAccountsSql(ownerId)} AS "accounts",
    l.amount_minor::text AS "amountMinor",
    (
      SELECT CASE WHEN COUNT(*) > 1 THEN SUM(sl.amount_minor)::text END
      FROM entry_lines sl
      JOIN ledger_accounts sa ON sa.id = sl.ledger_account_id
      WHERE sl.entry_id = e.id
        AND sa.owner_id = ${ownerId}::uuid
        AND sa.kind IN ('income', 'expense')
    ) AS "entryTotalMinor",
    ${correctionLinksSql(ownerId)}
  FROM entry_lines l
  JOIN entries e ON e.id = l.entry_id
  JOIN ledger_accounts a ON a.id = l.ledger_account_id
  WHERE e.owner_id = ${ownerId}::uuid
    AND a.owner_id = ${ownerId}::uuid
    AND a.kind IN ('income', 'expense')
    AND l.project_id = ${projectId}::uuid
    AND l.excluded_from_reporting = false
  ORDER BY e.occurred_on DESC, e.id DESC, l.id
  LIMIT ${MAX_PROJECT_REPORT_LINES + 1}
`;

export const selectProjectLines = async (
  db: Db,
  ownerId: string,
  projectId: string,
): Promise<{ lines: ProjectLine[]; truncated: boolean }> => {
  const rows = ProjectLine.array().parse(
    await db.$queryRaw(projectLinesSql(ownerId, projectId)),
  );
  return {
    lines: rows.slice(0, MAX_PROJECT_REPORT_LINES),
    truncated: rows.length > MAX_PROJECT_REPORT_LINES,
  };
};
