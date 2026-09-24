/**
 * mulberry32. Same seed, same sequence, on any machine and any Node — which is
 * the whole point: seed data that changes between runs cannot be relied on to
 * show the same thing twice. Never used for money except through `minorUnits`,
 * which deals in integer cents and never in a float.
 */
export type Rng = {
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  minorUnits(minCents: number, maxCents: number): bigint;
  chance(percent: number): boolean;
};

export const createRng = (seed: number): Rng => {
  let state = seed >>> 0;

  const float = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (minInclusive: number, maxInclusive: number): number =>
    minInclusive + Math.floor(float() * (maxInclusive - minInclusive + 1));

  return {
    int,
    pick: <T>(items: readonly T[]): T => {
      const item = items[int(0, items.length - 1)];
      if (item === undefined) throw new Error('cannot pick from an empty list');
      return item;
    },
    minorUnits: (minCents, maxCents) => BigInt(int(minCents, maxCents)),
    chance: (percent) => int(1, 100) <= percent,
  };
};
