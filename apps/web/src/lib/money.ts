/**
 * US formatting, done by string manipulation on `bigint` minor units. Every
 * amount that reaches here is already display-signed by the API, so this
 * neither flips a sign nor does arithmetic — and it never touches `Number`,
 * where cents above 2^53 would silently stop being exact.
 */
type FormatOptions = {
  symbol?: boolean;
  signDisplay?: 'auto' | 'always';
};

export const formatMinorUnits = (
  value: bigint | string,
  { symbol = false, signDisplay = 'auto' }: FormatOptions = {},
): string => {
  const amount = typeof value === 'bigint' ? value : BigInt(value);
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(3, '0');

  const dollars = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = digits.slice(-2);
  const sign = negative ? '-' : signDisplay === 'always' ? '+' : '';

  return `${sign}${symbol ? '$' : ''}${dollars}.${cents}`;
};

/**
 * The inverse, for the amount field: a positive US decimal typed by a user
 * becomes a minor-units string. The tab decides the sign, not this.
 */
export const parseAmountToMinorUnits = (input: string): bigint | null => {
  const match = /^\s*\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!match) return null;

  const dollars = (match[1] ?? '').replace(/,/g, '');
  const cents = (match[2] ?? '').padEnd(2, '0');
  return BigInt(`${dollars}${cents}`);
};

/**
 * The magnitude of a signed amount, for a field that shows a positive number
 * while something else carries the direction — the Mark paid dialog's amount,
 * prefilled from a bill whose sign is fixed by the schedule.
 *
 * Spelled out here rather than at the call sites so the `Math.abs` ban stays a
 * grep, and so the one place that discards a sign is a place you can find.
 */
export const magnitudeMinorUnits = (value: bigint): bigint =>
  value < 0n ? -value : value;

export const isMoneyIn = (value: bigint | string): boolean =>
  (typeof value === 'bigint' ? value : BigInt(value)) > 0n;

/**
 * The browser's only money arithmetic (ADR-020), for the split editor's
 * allocated and remaining figures. They gate the Save button and nothing more:
 * the API and the zero-sum trigger decide whether a split balances.
 */
export const allocatedMinorUnits = (amounts: readonly bigint[]): bigint =>
  amounts.reduce((total, amount) => total + amount, 0n);

export const remainingMinorUnits = (total: bigint, allocated: bigint): bigint =>
  total - allocated;
