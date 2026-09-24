import {
  minorUnitsToString,
  type FallbackReason,
  type MeaningGroupWire,
  type NameGroupWire,
  type PayeeTotalWire,
  type SpendingReportRequest,
  type SpendingReportWire,
} from '@pfm/contracts';
import { forDisplay } from '../../shared/ledger/display-sign.js';
import type { PayeeGroupRow } from '../reporting/similar-groups.sql.js';
import { sumRows, type SemanticGroup } from './grouping.js';
import type { SemanticReport, SpendingReportResult } from './service.js';

/** As in the category report: seen from the expense side, so spending is positive. */
const spent = (amountMinor: bigint): bigint => forDisplay(amountMinor, 'expense');

const toWire = (row: PayeeGroupRow): PayeeTotalWire => ({
  payee: row.payee,
  totalMinor: minorUnitsToString(spent(row.totalMinor)),
  transactionCount: row.transactionCount,
  categories: row.categories,
});

/**
 * The rows arrive ranked, so the largest is the first — but only when it is
 * spending. A period whose biggest merchant nets out negative, because a refund
 * landed after the purchase, has no "most expensive" to highlight, and marking
 * one would answer a question the user did not ask.
 */
const markLargest = (rows: PayeeGroupRow[]): NameGroupWire[] => {
  const largest = rows.findIndex((row) => spent(row.totalMinor) > 0n);
  return rows.map((row, index) => ({ ...toWire(row), isLargest: index === largest }));
};

/**
 * Ranked like the deterministic report, with two exceptions that are the whole
 * point of the `Other` bucket: it sorts last however large it is, because it is
 * a remainder rather than a kind of spending, and it is never marked largest.
 */
const rankGroups = (groups: SemanticGroup[]): MeaningGroupWire[] => {
  const totals = groups.map((group) => ({ ...group, total: spent(sumRows(group.payees)) }));

  totals.sort((a, b) => {
    if (a.origin !== b.origin) return a.origin === 'other' ? 1 : -1;
    if (a.total !== b.total) return a.total > b.total ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  const largest = totals.findIndex((group) => group.origin === 'model' && group.total > 0n);

  return totals.map((group, index) => ({
    label: group.label,
    origin: group.origin,
    totalMinor: minorUnitsToString(group.total),
    isLargest: index === largest,
    payees: group.payees.map(toWire),
  }));
};

/**
 * `totalMinor` is the total of the groups shown, not of the period: merchants
 * past the ranking's cap, and spending with no payee to group under, are in
 * neither. The view labels it "total spent, grouped" for that reason, and it is
 * the figure the semantic grouping reconciles against.
 *
 * It is computed from the same rows under both groupings, so the two views of
 * one period always agree — the semantic report reorganises the rows and never
 * re-totals them.
 */
const periodTotal = (rows: PayeeGroupRow[]): string =>
  minorUnitsToString(rows.reduce((total, row) => total + spent(row.totalMinor), 0n));

const nameGrouped = (
  request: SpendingReportRequest,
  rows: PayeeGroupRow[],
  fallback: FallbackReason | null,
): SpendingReportWire => ({
  from: request.from,
  to: request.to,
  totalMinor: periodTotal(rows),
  grouping: 'name',
  groups: markLargest(rows),
  fallback,
});

const meaningGrouped = (
  request: SpendingReportRequest,
  rows: PayeeGroupRow[],
  semantic: SemanticReport,
): SpendingReportWire => ({
  from: request.from,
  to: request.to,
  totalMinor: periodTotal(rows),
  grouping: 'meaning',
  groups: rankGroups(semantic.groups),
  sent: semantic.sent,
});

export const toSpendingReport = (
  request: SpendingReportRequest,
  result: SpendingReportResult,
): SpendingReportWire =>
  result.grouping === 'meaning'
    ? meaningGrouped(request, result.rows, result.semantic)
    : nameGrouped(request, result.rows, result.fallback);
