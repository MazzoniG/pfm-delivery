export type Cached<T> = { value: T; at: Date };

export type ReportCache<T> = {
  get(key: string): Cached<T> | null;
  set(key: string, value: T, at: Date): void;
};

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 50;

/**
 * In-process, per-instance, and deliberately small: it exists so that pressing
 * Generate twice does not pay for the model twice, not to be a store.
 *
 * **The key includes the owner.** A cache keyed on the period alone would serve
 * one tenant's merchants to another, and it is the one tenancy leak no
 * repository `WHERE` clause can catch — see {@link cacheKey}.
 *
 * Behind more than one API instance this becomes a per-instance cache, which
 * costs an extra model call on a miss and is otherwise harmless. The scaling
 * path is Redis under the same key, and the key is why that swap is safe.
 */
export const createReportCache = <T>(ttlMs = TTL_MS): ReportCache<T> => {
  const entries = new Map<string, Cached<T>>();

  return {
    get: (key) => {
      const hit = entries.get(key);
      if (hit === undefined) return null;
      if (Date.now() - hit.at.getTime() > ttlMs) {
        entries.delete(key);
        return null;
      }
      return hit;
    },

    set: (key, value, at) => {
      // Oldest insertion first, which is what a Map iterates.
      if (entries.size >= MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, { value, at });
    },
  };
};

/**
 * Owner, period, and the rows the grouping was computed from.
 *
 * The rows are in the key because the cached value is a grouping *of* them: a
 * report generated again after a transaction is posted must not serve groups
 * that predate it against the new total. Keying on the period alone made that
 * mismatch possible, and the figures on screen then did not add up.
 */
export const cacheKey = (
  ownerId: string,
  period: { from: string; to: string; projectId?: string | undefined },
  rows: readonly { payee: string; totalMinor: bigint }[],
): string =>
  [
    ownerId,
    period.from,
    period.to,
    period.projectId ?? '',
    rows.map((row) => `${row.payee}=${row.totalMinor}`).join('|'),
  ].join(':');
