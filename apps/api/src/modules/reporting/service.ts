import type { AccountKind } from '@pfm/contracts';
import type { Db } from '../../shared/db/prisma.js';
import { NotFoundError } from '../../shared/errors/app-error.js';
import { selectBalances, type BalanceRow } from './balances.sql.js';
import {
  expenseCategoryExists,
  selectCategoryLines,
  selectCategoryMonthly,
  type CategoryLineRow,
  type CategoryMonthRow,
  type SpendingFilter,
} from './category-monthly.sql.js';
import { selectProjectLines } from './project-lines.sql.js';
import {
  selectLedgerDeltas,
  selectProjectionOccurrences,
  type LedgerDeltaRow,
  type ProjectionOccurrenceRow,
} from './projection.sql.js';
import { selectSimilarGroups, type PayeeGroupRow } from './similar-groups.sql.js';
import { selectProjectTotals, type ProjectTotalsRow } from './project-totals.sql.js';
import type { ProjectLine } from '@pfm/contracts';

/** An `account`-level row, with the three columns the rollup levels leave null. */
export type AccountBalanceRow = BalanceRow & {
  kind: AccountKind;
  ledgerAccountId: string;
  archived: boolean;
};

export const isAccountBalanceRow = (row: BalanceRow): row is AccountBalanceRow =>
  row.level === 'account' &&
  row.kind !== null &&
  row.ledgerAccountId !== null &&
  row.archived !== null;

export type BalanceSet = { asOf: string; rows: BalanceRow[] };
export type AccountBalanceResult = { asOf: string; row: AccountBalanceRow };

export type ProjectReportResult = {
  project: ProjectTotalsRow;
  spending: CategoryMonthRow[];
  lines: ProjectLine[];
  linesTruncated: boolean;
};

/**
 * What the projection needs from the recurring module and nothing more:
 * occurrences are written on demand, so the horizon has to be materialised
 * before it can be read. Stated as a port rather than an import of the whole
 * service, so the dependency reads as one verb.
 */
export type OccurrenceExpansion = {
  expandThrough(ownerId: string, horizon: Date): Promise<void>;
};

export type ProjectionPointResult = {
  on: string;
  netWorthMinor: bigint;
  basis: 'actual' | 'projected';
};

export type OccurrenceGroupResult = {
  netMinor: bigint;
  occurrences: ProjectionOccurrenceRow[];
};

export type ProjectionResult = {
  asOf: string;
  to: string;
  netWorthMinor: bigint;
  projectedNetWorthMinor: bigint;
  series: ProjectionPointResult[];
  overdue: OccurrenceGroupResult;
  scheduled: OccurrenceGroupResult;
};

/**
 * The solid half of the chart when the forward half is short. Without a floor,
 * a one-week horizon would draw a week of history and read as noise; with it
 * the past mirrors the future once the horizon is a month or more, which is
 * what every option the bills page offers produces.
 */
const MIN_HISTORY_DAYS = 30;

const DAY_MS = 86_400_000;

const parseDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const shiftDays = (iso: string, days: number): string =>
  new Date(parseDate(iso).getTime() + days * DAY_MS).toISOString().slice(0, 10);

const daysBetween = (from: string, to: string): number =>
  Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS);

const sum = <T>(rows: readonly T[], of: (row: T) => bigint): bigint =>
  rows.reduce((total, row) => total + of(row), 0n);

type DatedDelta = LedgerDeltaRow & { on: string };

/**
 * Assembles the projection from a ledger it can add up and a list of things
 * that have not happened. Kept apart from the queries because this is where the
 * rule that defines the feature lives, and it should be readable in one place:
 *
 * `projection(to)` is the ledger at `to` — which already includes future-dated
 * real entries — plus every unpaid occurrence due from today through `to`.
 *
 * Overdue occurrences are **not** in it. The projection starts from today's
 * balance, and an occurrence due before today that was never materialised is
 * money that has not moved: adding it would claim a payment that did not
 * happen, and ignoring it silently would hide a real obligation. It is returned
 * beside the figure, with its own net, so the page can say what the forecast
 * leaves out. Nothing dismisses an overdue occurrence — it stays listed until
 * it is paid. See ADR-030.
 */
const assemble = (
  asOf: string,
  to: string,
  windowStart: string,
  deltas: LedgerDeltaRow[],
  occurrences: ProjectionOccurrenceRow[],
): ProjectionResult => {
  const opening = deltas.find((row) => row.on === null)?.deltaMinor ?? 0n;
  const changes = deltas.filter((row): row is DatedDelta => row.on !== null);

  const netWorthMinor =
    opening + sum(changes, (c) => (c.on <= asOf ? c.deltaMinor : 0n));
  const ledgerAtTo =
    opening + sum(changes, (c) => (c.on <= to ? c.deltaMinor : 0n));

  const overdue = occurrences.filter((o) => o.dueOn < asOf);
  const scheduled = occurrences.filter((o) => o.dueOn >= asOf && o.dueOn <= to);
  const scheduledNet = sum(scheduled, (o) => o.amountMinor);

  const series: ProjectionPointResult[] = [];
  const past = changes.filter((c) => c.on <= asOf);

  // The window's own opening point, unless something happened on that very day
  // and the loop is about to emit it.
  if (past[0]?.on !== windowStart) {
    series.push({ on: windowStart, netWorthMinor: opening, basis: 'actual' });
  }
  let running = opening;
  for (const change of past) {
    running += change.deltaMinor;
    series.push({ on: change.on, netWorthMinor: running, basis: 'actual' });
  }
  if (series.at(-1)?.on !== asOf) {
    series.push({ on: asOf, netWorthMinor: running, basis: 'actual' });
  }

  // The dashed half moves on two kinds of date: a real entry already posted
  // ahead of today, and a bill that has not happened at all.
  const forward = changes.filter((c) => c.on > asOf && c.on <= to);
  const moves = [
    ...new Set([...forward.map((c) => c.on), ...scheduled.map((o) => o.dueOn)]),
  ].sort();

  let projected = netWorthMinor;
  for (const on of moves) {
    projected +=
      sum(forward, (c) => (c.on === on ? c.deltaMinor : 0n)) +
      sum(scheduled, (o) => (o.dueOn === on ? o.amountMinor : 0n));
    series.push({ on, netWorthMinor: projected, basis: 'projected' });
  }
  if (to > asOf && series.at(-1)?.on !== to) {
    series.push({ on: to, netWorthMinor: projected, basis: 'projected' });
  }

  return {
    asOf,
    to,
    netWorthMinor,
    // Computed from the aggregates, not read off the last chart point: the
    // figure is the claim, and the chart is a drawing of it.
    projectedNetWorthMinor: ledgerAtTo + scheduledNet,
    series,
    overdue: { netMinor: sum(overdue, (o) => o.amountMinor), occurrences: overdue },
    scheduled: { netMinor: scheduledNet, occurrences: scheduled },
  };
};

export type ReportingService = {
  balances(ownerId: string, asOf?: string): Promise<BalanceSet>;
  accountBalance(
    ownerId: string,
    ledgerAccountId: string,
    asOf?: string,
  ): Promise<AccountBalanceResult>;
  categoryMonthly(ownerId: string, filter: SpendingFilter): Promise<CategoryMonthRow[]>;
  /** Merchants ranked by spend — the insights module's half of the reporting surface. */
  similarGroups(ownerId: string, filter: SpendingFilter): Promise<PayeeGroupRow[]>;
  categoryLines(
    ownerId: string,
    ledgerAccountId: string,
    filter: SpendingFilter,
  ): Promise<CategoryLineRow[]>;
  projects(ownerId: string): Promise<ProjectTotalsRow[]>;
  projectReport(
    ownerId: string,
    projectId: string,
    period: { from: string; to: string },
  ): Promise<ProjectReportResult>;
  projection(ownerId: string, to: string): Promise<ProjectionResult>;
};

export const createReportingService = (
  db: Db,
  expansion: OccurrenceExpansion,
  now: () => Date = () => new Date(),
): ReportingService => {
  // Resolved per request, never at module load: a process that stays up across
  // midnight would otherwise answer yesterday's balance forever.
  const resolve = (asOf?: string): string =>
    asOf ?? now().toISOString().slice(0, 10);

  return {
    balances: async (ownerId, asOf) => {
      const on = resolve(asOf);
      return { asOf: on, rows: await selectBalances(db, ownerId, on) };
    },

    accountBalance: async (ownerId, ledgerAccountId, asOf) => {
      const on = resolve(asOf);
      const rows = await selectBalances(db, ownerId, on);
      // The query only ever returns this owner's accounts, so an id that is
      // someone else's is simply absent — a 404 that falls out of the `WHERE`
      // clause, not a fabricated zero and not a 403 confirming the row exists.
      const row = rows
        .filter(isAccountBalanceRow)
        .find((candidate) => candidate.ledgerAccountId === ledgerAccountId);

      if (!row) {
        throw new NotFoundError(
          'Account not found',
          `No account with id ${ledgerAccountId}.`,
        );
      }
      return { asOf: on, row };
    },

    categoryMonthly: (ownerId, filter) => selectCategoryMonthly(db, ownerId, filter),

    similarGroups: (ownerId, filter) => selectSimilarGroups(db, ownerId, filter),

    // An empty list would be a true answer for a category with no spending, so
    // an id this owner has no expense category under must be told apart from
    // it: another owner's id, an income category and a typo are all a 404.
    categoryLines: async (ownerId, ledgerAccountId, filter) => {
      if (!(await expenseCategoryExists(db, ownerId, ledgerAccountId))) {
        throw new NotFoundError(
          'Category not found',
          `No expense category with id ${ledgerAccountId}.`,
        );
      }
      return selectCategoryLines(db, ownerId, ledgerAccountId, filter);
    },

    projects: (ownerId) => selectProjectTotals(db, ownerId),

    // The totals query is owner-scoped, so another owner's project is absent
    // from it — the same 404 as an id that never existed.
    projectReport: async (ownerId, projectId, period) => {
      const [project] = await selectProjectTotals(db, ownerId, projectId);
      if (!project) {
        throw new NotFoundError('Project not found', `No project with id ${projectId}.`);
      }
      const [spending, { lines, truncated }] = await Promise.all([
        selectCategoryMonthly(db, ownerId, { ...period, projectId }, { periodTotals: true }),
        selectProjectLines(db, ownerId, projectId),
      ]);
      return { project, spending, lines, linesTruncated: truncated };
    },

    projection: async (ownerId, to) => {
      const asOf = resolve();
      // Always at least as far as today, so the overdue group is complete even
      // when the caller asked for a horizon that has already passed.
      const queryTo = to > asOf ? to : asOf;

      // Materialise before reading. This is also where a horizon past the cap
      // is refused, so no query runs and no rows are written for one.
      await expansion.expandThrough(ownerId, parseDate(queryTo));

      const horizonDays = Math.max(daysBetween(asOf, to), 0);
      const windowStart = shiftDays(
        asOf,
        -Math.max(horizonDays, MIN_HISTORY_DAYS),
      );

      const [deltas, occurrences] = await Promise.all([
        selectLedgerDeltas(db, ownerId, windowStart, queryTo),
        selectProjectionOccurrences(db, ownerId, queryTo),
      ]);

      return assemble(asOf, to, windowStart, deltas, occurrences);
    },
  };
};
