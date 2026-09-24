import { z } from 'zod';

export const Uuid = z.uuid();

/** Transaction dates are calendar dates. This rejects a timestamp on purpose. */
export const CalendarDate = z.iso.date();

/** Audit instants only. Never interchangeable with {@link CalendarDate}. */
export const Timestamp = z.iso.datetime({ offset: true });

export const LedgerAccountKind = z.enum([
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
]);
export type LedgerAccountKind = z.infer<typeof LedgerAccountKind>;

/** The two windows onto `ledger_accounts`. A query over it constrains one or the other. */
export const ACCOUNT_KINDS = ['asset', 'liability'] as const;
export const CATEGORY_KINDS = ['income', 'expense'] as const;

/**
 * Every kind, for the one query that legitimately spans all of them: an entry
 * line may name any account in the chart. Stated rather than omitted, so that
 * "a query over `ledger_accounts` without a `kind` constraint is a bug" stays a
 * rule a reader can check by looking, with no call site exempt from it.
 */
export const LEDGER_ACCOUNT_KINDS = [
  ...ACCOUNT_KINDS,
  ...CATEGORY_KINDS,
  'equity',
] as const;

export const EntryRef = z.object({ id: Uuid, occurredOn: CalendarDate });
export type EntryRef = z.infer<typeof EntryRef>;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export const Keyset = z.object({ occurredOn: CalendarDate, id: Uuid });
export type Keyset = z.infer<typeof Keyset>;

export const encodeCursor = ({ occurredOn, id }: Keyset): string =>
  `${occurredOn}:${id}`;

/**
 * The cursor is the keyset tuple `(occurred_on, id)` itself, in the order the
 * register sorts by — readable rather than opaque, and re-validated on the way
 * back in, so a hand-edited cursor is a 400 and never reaches SQL.
 */
export const Cursor = z.string().transform((raw, ctx): Keyset => {
  const separator = raw.indexOf(':');
  const parsed = Keyset.safeParse({
    occurredOn: raw.slice(0, Math.max(separator, 0)),
    id: raw.slice(separator + 1),
  });
  if (!parsed.success) {
    ctx.addIssue({ code: 'custom', message: 'not a valid pagination cursor' });
    return z.NEVER;
  }
  return parsed.data;
});

export const PageQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  cursor: Cursor.optional(),
});

export const page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.string().nullable() });
