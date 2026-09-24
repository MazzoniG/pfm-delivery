import {
  minorUnitsToString,
  type AccountBalanceResponseWire,
  type AccountBalanceWire,
  type AccountKind,
  type BalancesResponseWire,
  type CategoryLinesWire,
  type CategoryReportWire,
  type CategoryTotalWire,
  type KindSubtotalsWire,
  type MonthSpendingWire,
  type OccurrenceGroupWire,
  type ProjectListWire,
  type ProjectionResponseWire,
  type ProjectReportWire,
  type ProjectSummaryWire,
  repeatRuleOf,
  type ScheduledOccurrenceViewWire,
} from '@pfm/contracts';
import { forDisplay } from '../../shared/ledger/display-sign.js';
import {
  isAccountBalanceRow,
  type AccountBalanceRow,
  type OccurrenceGroupResult,
  type ProjectionResult,
  type ProjectReportResult,
} from './service.js';
import type { ProjectionOccurrenceRow } from './projection.sql.js';
import type { ProjectTotalsRow } from './project-totals.sql.js';
import type { BalanceRow } from './balances.sql.js';
import type { CategoryLineRow, CategoryMonthRow, SpendingFilter } from './category-monthly.sql.js';

const toAccountBalance = (row: AccountBalanceRow): AccountBalanceWire => ({
  ledgerAccountId: row.ledgerAccountId,
  kind: row.kind,
  archived: row.archived,
  balanceMinor: minorUnitsToString(forDisplay(row.balanceMinor, row.kind)),
});

/**
 * A kind with no accounts produces no rollup row, so the missing side defaults
 * to zero rather than leaving the contract a key short.
 */
const subtotals = (rows: BalanceRow[]): KindSubtotalsWire => {
  const of = (kind: AccountKind): string => {
    const row = rows.find((r) => r.level === 'kind' && r.kind === kind);
    return minorUnitsToString(row ? forDisplay(row.balanceMinor, kind) : 0n);
  };
  return { asset: of('asset'), liability: of('liability') };
};

export const toBalancesResponse = (
  asOf: string,
  rows: BalanceRow[],
): BalancesResponseWire => ({
  asOf,
  accounts: rows.filter(isAccountBalanceRow).map(toAccountBalance),
  subtotals: subtotals(rows),
  // Net worth is the raw signed grand total, never sign-flipped: the sum over
  // assets and liabilities already *is* net worth, and flipping it — or adding
  // the two display-signed subtotals — would count the debt as an asset.
  netWorthMinor: minorUnitsToString(
    rows.find((row) => row.level === 'total')?.balanceMinor ?? 0n,
  ),
});

export const toAccountBalanceResponse = (
  asOf: string,
  row: AccountBalanceRow,
): AccountBalanceResponseWire => ({ asOf, ...toAccountBalance(row) });

/**
 * Every figure in the category report is seen from the category's side, and
 * `displaySign('expense')` is `+1`: spending positive, a reversal negative. It
 * is still applied rather than skipped, so the rule lives in one place — and
 * the register's opposite sign for the same purchase is never "corrected" here
 * to match it.
 */
const spent = (amountMinor: bigint): string =>
  minorUnitsToString(forDisplay(amountMinor, 'expense'));

const toCategoryTotal = (row: CategoryMonthRow): CategoryTotalWire => ({
  ledgerAccountId: row.ledgerAccountId ?? '',
  name: row.name ?? '',
  totalMinor: spent(row.totalMinor),
  includesCorrection: row.includesCorrection,
});

/** The query returns months in order, each `month` row ahead of its categories. */
export const toCategoryReport = (
  filter: SpendingFilter,
  rows: CategoryMonthRow[],
): CategoryReportWire => {
  const months: MonthSpendingWire[] = [];
  for (const row of rows) {
    if (row.level === 'month') {
      months.push({ month: row.month ?? '', totalMinor: spent(row.totalMinor), categories: [] });
    } else if (row.level === 'category') {
      months.at(-1)?.categories.push(toCategoryTotal(row));
    }
  }
  return { from: filter.from, to: filter.to, months };
};

export const toCategoryLines = (
  ledgerAccountId: string,
  filter: SpendingFilter,
  rows: CategoryLineRow[],
): CategoryLinesWire => ({
  ledgerAccountId,
  from: filter.from,
  to: filter.to,
  lines: rows.map((row) => ({ ...row, amountMinor: spent(row.amountMinor) })),
});

/**
 * Net cost and the project's lines stay raw signed — no `forDisplay`. They mix
 * expense and income lines, and a per-kind flip would turn a refund into more
 * spending; the raw sum is already the figure the user reads.
 */
const toProjectSummary = (row: ProjectTotalsRow): ProjectSummaryWire => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
  netCostMinor: minorUnitsToString(row.netCostMinor),
  transactionCount: row.transactionCount,
  firstActivityOn: row.firstActivityOn,
  lastActivityOn: row.lastActivityOn,
});

export const toProjectList = (rows: ProjectTotalsRow[]): ProjectListWire =>
  rows.map(toProjectSummary);

/** The chart and category table are the category report's, over this project's lines. */
export const toProjectReport = (
  period: { from: string; to: string },
  result: ProjectReportResult,
): ProjectReportWire => ({
  project: toProjectSummary(result.project),
  ...toCategoryReport(period, result.spending),
  categories: result.spending.filter((row) => row.level === 'period').map(toCategoryTotal),
  lines: result.lines.map((line) => ({
    ...line,
    amountMinor: minorUnitsToString(line.amountMinor),
    entryTotalMinor:
      line.entryTotalMinor === null ? null : minorUnitsToString(line.entryTotalMinor),
  })),
  linesTruncated: result.linesTruncated,
});

const toOccurrenceView = (
  row: ProjectionOccurrenceRow,
): ScheduledOccurrenceViewWire => ({
  id: row.id,
  seriesId: row.seriesId,
  dueOn: row.dueOn,
  amountMinor: minorUnitsToString(row.amountMinor),
  payee: row.payee,
  rule: repeatRuleOf(row.frequency, row.dayOfMonth, row.seriesId),
  ledgerAccountId: row.ledgerAccountId,
  ledgerAccountName: row.ledgerAccountName,
  categoryId: row.categoryId,
  categoryName: row.categoryName,
});

const toOccurrenceGroup = (group: OccurrenceGroupResult): OccurrenceGroupWire => ({
  netMinor: minorUnitsToString(group.netMinor),
  occurrences: group.occurrences.map(toOccurrenceView),
});

/**
 * No `forDisplay` anywhere in here. Every figure is already in the net-worth
 * basis — the raw signed sum over asset and liability accounts, the same one
 * `BalancesResponse.netWorthMinor` is quoted in — and an occurrence's amount is
 * its effect on that. Flipping a card charge to read positive would be right
 * for a register row and wrong for a bill. See ADR-028.
 */
export const toProjection = (result: ProjectionResult): ProjectionResponseWire => ({
  asOf: result.asOf,
  to: result.to,
  netWorthMinor: minorUnitsToString(result.netWorthMinor),
  projectedNetWorthMinor: minorUnitsToString(result.projectedNetWorthMinor),
  series: result.series.map((point) => ({
    on: point.on,
    netWorthMinor: minorUnitsToString(point.netWorthMinor),
    basis: point.basis,
  })),
  overdue: toOccurrenceGroup(result.overdue),
  scheduled: toOccurrenceGroup(result.scheduled),
});
