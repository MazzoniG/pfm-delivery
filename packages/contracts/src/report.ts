import { z } from 'zod';
import { CalendarDate, EntryRef, Uuid } from './common.js';
import { MinorUnits } from './money.js';

export const YearMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month, YYYY-MM');
export type YearMonth = z.infer<typeof YearMonth>;

/** A generous ceiling on one request, far above anything the range control offers. */
export const MAX_REPORT_MONTHS = 24;

const monthIndex = (date: string): number =>
  Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

const period = { from: CalendarDate, to: CalendarDate };

export const withPeriodRules = <T extends z.ZodType<{ from: string; to: string }>>(
  schema: T,
) =>
  schema
    .refine((p) => p.from <= p.to, {
      message: 'must be on or before to',
      path: ['from'],
    })
    .refine((p) => monthIndex(p.to) - monthIndex(p.from) < MAX_REPORT_MONTHS, {
      message: `must be within ${MAX_REPORT_MONTHS} months of from`,
      path: ['to'],
    });

/**
 * `month` is not here. It is which bar the UI has selected, and every month in
 * the period comes back in one response, so choosing a bar costs no request.
 *
 * Totals cover only dates inside `from`–`to`: a `from` of the 15th trims the
 * first month to the 15th onwards. The report view always sends whole months.
 *
 * `projectId` is accepted and honoured, and nothing sends it yet: the project
 * filter is US5's, and the report view leaves it out until then. Another
 * owner's project id matches none of this owner's lines, so it answers zeros
 * rather than a 404 that would confirm the project exists.
 */
export const CategoryReportQuery = withPeriodRules(
  z.object({ ...period, projectId: Uuid.optional() }),
);
export type CategoryReportQuery = z.infer<typeof CategoryReportQuery>;

export const ReportPeriodQuery = withPeriodRules(z.object(period));
export type ReportPeriodQuery = z.infer<typeof ReportPeriodQuery>;

export const CategoryLinesQuery = ReportPeriodQuery;
export type CategoryLinesQuery = ReportPeriodQuery;

/**
 * Must name one of this owner's expense categories. Anything else — another
 * owner's category, an income category, an account — is a 404, the same
 * answer as an id that does not exist.
 */
export const CategoryIdParam = z.object({ ledgerAccountId: Uuid });
export type CategoryIdParam = z.infer<typeof CategoryIdParam>;

/**
 * Seen from the category's side of the entry, so spending is positive and a
 * reversal negative — the opposite sign to the same purchase in the register,
 * which looks from the bank account. Both are correct; neither is flipped to
 * match the other.
 */
export const CategoryTotal = z.object({
  ledgerAccountId: Uuid,
  name: z.string(),
  totalMinor: MinorUnits,
  /** Some entry behind this figure is a reversal or a replacement. */
  includesCorrection: z.boolean(),
});
export type CategoryTotal = z.infer<typeof CategoryTotal>;
export type CategoryTotalWire = z.input<typeof CategoryTotal>;

/**
 * One per calendar month in the period, zero months included. `totalMinor` is
 * the API's, not the sum of `categories`: the browser never adds money.
 * Categories are sorted by amount, largest first; a negative one sorts last.
 */
export const MonthSpending = z.object({
  month: YearMonth,
  totalMinor: MinorUnits,
  categories: z.array(CategoryTotal),
});
export type MonthSpending = z.infer<typeof MonthSpending>;
export type MonthSpendingWire = z.input<typeof MonthSpending>;

/**
 * Expenses only; US3 asks for nothing else. Lines excluded from reporting are
 * absent from every figure here while still counting in balances.
 */
export const CategoryReport = z.object({
  from: CalendarDate,
  to: CalendarDate,
  months: z.array(MonthSpending),
});
export type CategoryReport = z.infer<typeof CategoryReport>;
export type CategoryReportWire = z.input<typeof CategoryReport>;

export const FundingAccount = z.object({ ledgerAccountId: Uuid, name: z.string() });
export type FundingAccount = z.infer<typeof FundingAccount>;

/**
 * One category line, seen from the category — which is why this is not a
 * `TransactionRowView`: the register projects an entry from the account's side,
 * and the same purchase carries opposite signs in the two.
 *
 * `accounts` are the entry's asset and liability lines. Usually one; none for a
 * reclassification between categories; more than one for a purchase paid from
 * two accounts, which the UI collapses to `—Split—`.
 */
export const CategoryLine = z.object({
  entryId: Uuid,
  lineId: Uuid,
  occurredOn: CalendarDate,
  payee: z.string().nullable(),
  accounts: z.array(FundingAccount),
  amountMinor: MinorUnits,
  reverses: EntryRef.nullable(),
  reversedBy: EntryRef.nullable(),
  replaces: EntryRef.nullable(),
});
export type CategoryLine = z.infer<typeof CategoryLine>;
export type CategoryLineWire = z.input<typeof CategoryLine>;

/** Newest first, like the register. */
export const CategoryLines = z.object({
  ledgerAccountId: Uuid,
  from: CalendarDate,
  to: CalendarDate,
  lines: z.array(CategoryLine),
});
export type CategoryLines = z.infer<typeof CategoryLines>;
export type CategoryLinesWire = z.input<typeof CategoryLines>;
