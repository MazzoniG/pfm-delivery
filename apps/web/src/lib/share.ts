/**
 * The width of a share bar, as a percentage of the largest row.
 *
 * Presentation only, and the one place the report views convert money to a JS
 * number (ADR-021): the bar carries no figure, so the conversion cannot put a
 * wrong amount in front of anyone. A negative total draws at its magnitude, in
 * the caller's correction tone.
 */
export const shareWidth = (total: bigint, largest: bigint): string => {
  if (largest <= 0n) return '0%';
  const value = Number(total);
  const magnitude = value < 0 ? -value : value;
  return `${Math.min(100, (magnitude / Number(largest)) * 100)}%`;
};
