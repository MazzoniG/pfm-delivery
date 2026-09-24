import { z } from 'zod';
import { CalendarDate, EntryRef, Timestamp, Uuid } from './common.js';
import { MinorUnits } from './money.js';
import { ProblemDetails } from './problem.js';
import { CategoryTotal, FundingAccount, MonthSpending, ReportPeriodQuery } from './report.js';

export const ProjectName = z.string().trim().min(1).max(80);

/**
 * No `archivedAt`: a project in use cannot be deleted, an unused one can, and
 * nothing asks for a third state. Names are unique per owner, so a duplicate is
 * a 409.
 */
export const Project = z.object({
  id: Uuid,
  name: ProjectName,
  createdAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

export const CreateProjectRequest = z.object({ name: ProjectName });
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const UpdateProjectRequest = z.object({ name: ProjectName });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

export const ProjectIdParam = z.object({ id: Uuid });
export type ProjectIdParam = z.infer<typeof ProjectIdParam>;

/**
 * `netCostMinor` is the raw signed sum of the project's lines, with no display
 * sign: an expense line adds to it and a refund booked to the project as income
 * reduces it, the same property that makes net worth a plain sum.
 *
 * Every figure here honours `excludedFromReporting`, so the count and the date
 * span describe the same lines the net cost adds up. The dates are null only
 * for a project with no such lines.
 */
export const ProjectSummary = Project.extend({
  netCostMinor: MinorUnits,
  transactionCount: z.number().int().nonnegative(),
  firstActivityOn: CalendarDate.nullable(),
  lastActivityOn: CalendarDate.nullable(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;
export type ProjectSummaryWire = z.input<typeof ProjectSummary>;

/** Most recent activity first; projects with none follow, newest created first. */
export const ProjectList = z.array(ProjectSummary);
export type ProjectListWire = z.input<typeof ProjectList>;

/**
 * The 409 from deleting a project that lines still reference. The count is
 * every entry holding such a line, excluded or not — it answers what blocks the
 * delete, not what the project costs — and `detail` states it in words.
 */
export const ProjectInUseProblem = ProblemDetails.extend({
  status: z.literal(409),
  transactionCount: z.number().int().positive(),
});
export type ProjectInUseProblem = z.infer<typeof ProjectInUseProblem>;

/**
 * Must name one of this owner's projects; another owner's is a 404, the same
 * answer as an id that does not exist. The report view sends six whole months
 * ending with the current one.
 */
export const ProjectReportQuery = ReportPeriodQuery;
export type ProjectReportQuery = ReportPeriodQuery;

/**
 * One of the project's lines, seen from the category side like the category
 * drill-down, but carrying the raw signed amount so that a refund reads
 * negative and the lines add up to the net cost.
 *
 * `entryTotalMinor` is set when the line is one of several income or expense
 * lines in its entry — a split — and is the sum of those lines, in the same
 * orientation: 200.00 of 230.00. Null for an unsplit line.
 */
export const ProjectLine = z.object({
  entryId: Uuid,
  lineId: Uuid,
  occurredOn: CalendarDate,
  payee: z.string().nullable(),
  ledgerAccountId: Uuid,
  categoryName: z.string(),
  accounts: z.array(FundingAccount),
  amountMinor: MinorUnits,
  entryTotalMinor: MinorUnits.nullable(),
  reverses: EntryRef.nullable(),
  reversedBy: EntryRef.nullable(),
  replaces: EntryRef.nullable(),
});
export type ProjectLine = z.infer<typeof ProjectLine>;
export type ProjectLineWire = z.input<typeof ProjectLine>;

/** A ceiling, not a page size: past it the report says so rather than paginating. */
export const MAX_PROJECT_REPORT_LINES = 500;

/**
 * `months` and `categories` are the category report restricted to this
 * project, so they cover expense lines inside `from`–`to` only; `categories`
 * totals the whole period rather than one month. `project` and `lines` are the
 * project's whole history. A refund therefore lowers the net cost and appears
 * among the lines, but not in the spending chart.
 *
 * `lines` is newest first and capped at {@link MAX_PROJECT_REPORT_LINES};
 * `linesTruncated` says the cap was hit, so a short list is never mistaken for
 * the whole project. The figures are unaffected — they are aggregates, not sums
 * of `lines`. A project that outgrows the cap takes the register's keyset cursor.
 */
export const ProjectReport = z.object({
  project: ProjectSummary,
  from: CalendarDate,
  to: CalendarDate,
  months: z.array(MonthSpending),
  categories: z.array(CategoryTotal),
  lines: z.array(ProjectLine).max(MAX_PROJECT_REPORT_LINES),
  linesTruncated: z.boolean(),
});
export type ProjectReport = z.infer<typeof ProjectReport>;
export type ProjectReportWire = z.input<typeof ProjectReport>;
