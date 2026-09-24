import type { LedgerAccountKind } from '@pfm/contracts';

/**
 * The single place a sign is flipped. Assets and expenses are naturally
 * positive in storage; liabilities, equity and income are naturally negative.
 * A $3,000 salary is stored −300000 and presents as +3000.00; $800 owed on a
 * card is stored −80000 and presents as 800.00 owed.
 *
 * Nothing in a service, a query or the frontend may flip a sign again, and
 * `Math.abs` is never the answer — it would erase the difference between a
 * charge and a refund.
 */
export const displaySign = (kind: LedgerAccountKind): 1n | -1n =>
  kind === 'asset' || kind === 'expense' ? 1n : -1n;

export const forDisplay = (amountMinor: bigint, kind: LedgerAccountKind): bigint =>
  amountMinor * displaySign(kind);
