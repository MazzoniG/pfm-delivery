import { z } from 'zod';
import { LedgerAccountKind, Timestamp, Uuid } from './common.js';
import { MinorUnits } from './money.js';

export const EntryLine = z.object({
  id: Uuid,
  ledgerAccountId: Uuid,
  ledgerAccountName: z.string(),
  ledgerAccountKind: LedgerAccountKind,
  /**
   * Raw signed minor units, exactly as posted: debit positive, credit negative,
   * and an entry's lines sum to zero. No display sign — that belongs to
   * {@link TransactionRowView}, which is a projection. These lines can be
   * handed straight back to a create or patch payload.
   */
  amountMinor: MinorUnits,
  projectId: Uuid.nullable(),
  excludedFromReporting: z.boolean(),
  reconciledAt: Timestamp.nullable(),
});
export type EntryLine = z.infer<typeof EntryLine>;
export type EntryLineWire = z.input<typeof EntryLine>;

/**
 * `projectId` and `excludedFromReporting` are meaningful only on income and
 * expense lines — which account a line names decides that, so the rule is the
 * service's to enforce, not this schema's.
 */
export const EntryLineInput = z.object({
  ledgerAccountId: Uuid,
  /** Mirrors the database CHECK: a zero line carries no money and posts nothing. */
  amountMinor: MinorUnits.refine((v) => v !== 0n, 'must not be zero'),
  projectId: Uuid.nullable().default(null),
  excludedFromReporting: z.boolean().default(false),
});
export type EntryLineInput = z.infer<typeof EntryLineInput>;

export const sumsToZero = (lines: readonly { amountMinor: bigint }[]): boolean =>
  lines.reduce((total, line) => total + line.amountMinor, 0n) === 0n;
