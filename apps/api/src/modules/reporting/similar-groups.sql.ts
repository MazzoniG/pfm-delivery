import { Prisma } from '@prisma/client';
import { PayeeTotal } from '@pfm/contracts';
import type { Db } from '../../shared/db/prisma.js';
import type { SpendingFilter } from './category-monthly.sql.js';

export type PayeeGroupRow = PayeeTotal;

/**
 * How many groups one report ranks. Also the ceiling on how many merchant names
 * the semantic grouping may send, which is why it is a constant and not a
 * caller's choice: the payload has to be bounded by something the reader of
 * this file can find.
 */
export const MAX_SPENDING_GROUPS = 25;

/**
 * The matching rule, and the one place a comment is owed, because it is a
 * business rule rather than an implementation:
 *
 *   1. case-fold, so AMAZON MKTP and Amazon Mktp are one merchant;
 *   2. replace every run of punctuation and whitespace with a single space, so
 *      `Tile & Stone Co` and `TILE AND`-style spacing variants collapse — this
 *      is also what turns `Amazon Mktp*2A1` into `amazon mktp 2a1`;
 *   3. drop trailing tokens that contain a digit, which is what a card network
 *      appends: a store number, a terminal id, an order reference. `2a1` goes,
 *      and `amazon mktp` is left to match `AMAZON MKTP`.
 *
 * Step 3 is deliberately trailing-only. `7-Eleven` normalises to `7 eleven` and
 * keeps both tokens, and a leading network prefix like `SQ *Coffee Bar` keeps
 * its merchant rather than collapsing every Square payment into one group.
 * It does merge `Shell 1120` with `Shell 4408` — two stations of one brand,
 * which is the intended reading of "similar transactions".
 *
 * A name that is nothing but digits would normalise to the empty string, so the
 * result falls back to the merely case-folded name rather than joining every
 * such payee into one group.
 */
const normalisedPayee = (column: Prisma.Sql): Prisma.Sql => Prisma.sql`
  COALESCE(
    NULLIF(
      regexp_replace(
        btrim(regexp_replace(lower(${column}), '[^a-z0-9]+', ' ', 'g')),
        '( [a-z0-9]*[0-9][a-z0-9]*)+$', ''
      ),
      ''
    ),
    btrim(lower(${column}))
  )
`;

/**
 * Spending grouped by merchant and ranked, the deterministic half of the
 * insights report. Every figure the feature ever shows is summed here.
 *
 * Same reporting rules as the category report — owner on both tables,
 * `kind = 'expense'`, excluded lines out, the period inclusive — so a payee's
 * total and its category's total are answers about the same lines.
 *
 * Entries with no payee are left out: there is no name to group them under, and
 * the report says "total spent, grouped" rather than claiming to be the period's
 * whole spending. Truncation at {@link MAX_SPENDING_GROUPS} works the same way.
 *
 * The inner grouping is by payee *and* category, because a merchant booked to
 * two categories is two facts about that merchant; the outer one ranks payees
 * and collects their categories. `COUNT(DISTINCT entry_id)` is taken at the
 * payee grain, so a purchase split across two categories counts once.
 *
 * The displayed spelling is the one the merchant is written as most often, so a
 * group named from three plain statements and one all-caps line reads as the
 * plain one. Ties break alphabetically, for stability rather than meaning.
 *
 * No `ABS()` and no `HAVING total > 0`: a month holding more refund than
 * purchase for a merchant is genuinely negative, and it sorts last, as it
 * should. Ties break on the normalised key so the ranking is stable run to run.
 */
export const similarGroupsSql = (
  ownerId: string,
  filter: SpendingFilter,
  limit: number = MAX_SPENDING_GROUPS,
): Prisma.Sql => Prisma.sql`
  WITH spending AS (
    SELECT
      e.id AS entry_id,
      e.occurred_on,
      e.payee,
      ${normalisedPayee(Prisma.sql`e.payee`)} AS payee_key,
      a.id AS category_id,
      a.name AS category_name,
      l.amount_minor
    FROM entry_lines l
    JOIN entries e ON e.id = l.entry_id
    JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.owner_id = ${ownerId}::uuid
      AND a.owner_id = ${ownerId}::uuid
      AND a.kind = 'expense'
      AND l.excluded_from_reporting = false
      AND e.occurred_on BETWEEN ${filter.from}::date AND ${filter.to}::date
      AND btrim(COALESCE(e.payee, '')) <> ''
      ${filter.projectId ? Prisma.sql`AND l.project_id = ${filter.projectId}::uuid` : Prisma.empty}
  ),
  by_category AS (
    SELECT
      s.payee_key,
      s.category_name,
      SUM(s.amount_minor) AS total_minor
    FROM spending s
    GROUP BY s.payee_key, s.category_id, s.category_name
  ),
  by_payee AS (
    SELECT
      s.payee_key,
      SUM(s.amount_minor) AS total_minor,
      COUNT(DISTINCT s.entry_id)::int AS transaction_count
    FROM spending s
    GROUP BY s.payee_key
  )
  SELECT
    (
      SELECT v.payee
      FROM spending v
      WHERE v.payee_key = p.payee_key
      GROUP BY v.payee
      ORDER BY COUNT(DISTINCT v.entry_id) DESC, v.payee
      LIMIT 1
    ) AS "payee",
    p.total_minor::text AS "totalMinor",
    p.transaction_count AS "transactionCount",
    (
      SELECT json_agg(c.category_name ORDER BY c.total_minor DESC, c.category_name)
      FROM by_category c
      WHERE c.payee_key = p.payee_key
    ) AS "categories"
  FROM by_payee p
  ORDER BY p.total_minor DESC, p.payee_key
  LIMIT ${limit}
`;

export const selectSimilarGroups = async (
  db: Db,
  ownerId: string,
  filter: SpendingFilter,
  limit?: number,
): Promise<PayeeGroupRow[]> =>
  PayeeTotal.array().parse(await db.$queryRaw(similarGroupsSql(ownerId, filter, limit)));
