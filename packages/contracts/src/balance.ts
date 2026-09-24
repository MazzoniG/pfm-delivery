import { z } from 'zod';
import { AccountKind } from './account.js';
import { CalendarDate, Uuid } from './common.js';
import { MinorUnits } from './money.js';

/**
 * `asOf` is optional and deliberately has no `.default()`: a default evaluated
 * here would be computed once at module load and freeze the date at process
 * start. The service resolves an absent `asOf` to the server's UTC date, per
 * request. The web client always sends the user's local date explicitly, so
 * that rule only ever applies to other consumers.
 *
 * Any date is accepted, future ones included — the balance of a ledger at a
 * future date is well defined. Capping the picker at today is the UI's rule.
 */
export const BalanceQuery = z.object({ asOf: CalendarDate.optional() });
export type BalanceQuery = z.infer<typeof BalanceQuery>;

export const AccountBalance = z.object({
  ledgerAccountId: Uuid,
  kind: AccountKind,
  /**
   * Archived accounts are returned and counted in every total; `archived` lets
   * the client drop them from the list without dropping their money. Names and
   * currency stay on the account list, which is a separate query — duplicating
   * them here would give the same field two sources.
   */
  archived: z.boolean(),
  /** Already carries its display sign via `displaySign(kind)`. Never flipped again. */
  balanceMinor: MinorUnits,
});
export type AccountBalance = z.infer<typeof AccountBalance>;
export type AccountBalanceWire = z.input<typeof AccountBalance>;

/**
 * The resolved date is echoed back so the client renders it rather than
 * re-deriving it.
 *
 * `kind` is `asset | liability`, so this shape cannot represent an income,
 * expense or equity account: those ids return **404**, the same answer as an id
 * belonging to another owner. Ownership and kind are both enforced by the
 * query's `WHERE` clause, and a 403 would confirm the row exists.
 *
 * An archived account keeps its own balance here — `archived` is carried rather
 * than filtered, because hiding an account is a presentation choice and its
 * money is still real.
 */
export const AccountBalanceResponse = AccountBalance.extend({
  asOf: CalendarDate,
});
export type AccountBalanceResponse = z.infer<typeof AccountBalanceResponse>;
export type AccountBalanceResponseWire = z.input<typeof AccountBalanceResponse>;

/**
 * Keyed by kind rather than a list, so neither level can be missing a group the
 * client then has to invent a zero for. Subtotals carry the display sign, like
 * the account rows: a card with 800 owed subtotals to `800`.
 */
export const KindSubtotals = z.object({
  asset: MinorUnits,
  liability: MinorUnits,
});
export type KindSubtotals = z.infer<typeof KindSubtotals>;
export type KindSubtotalsWire = z.input<typeof KindSubtotals>;

/**
 * Three levels, all computed server-side, because the browser must never add
 * money. They are not redundant: `netWorthMinor` is the raw signed sum over
 * asset and liability accounts and is never sign-flipped, so it is not the sum
 * of the two display-signed subtotals, which in turn are not the sum of the
 * visible `accounts` rows — archived accounts count in both totals while the
 * client hides them.
 */
export const BalancesResponse = z.object({
  asOf: CalendarDate,
  accounts: z.array(AccountBalance),
  subtotals: KindSubtotals,
  netWorthMinor: MinorUnits,
});
export type BalancesResponse = z.infer<typeof BalancesResponse>;
export type BalancesResponseWire = z.input<typeof BalancesResponse>;
