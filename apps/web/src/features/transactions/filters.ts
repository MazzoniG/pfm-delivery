import { useSearchParams } from 'react-router';

/**
 * The URL is the state. Selected account, date range and search live in search
 * params, the query key derives from them, and nothing here goes in a store —
 * which is what makes a pasted link reproduce the exact view.
 */
export const RANGES = {
  all: 'All time',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  ytd: 'This year',
} as const;

export type Range = keyof typeof RANGES;

const isRange = (value: string | null): value is Range =>
  value !== null && value in RANGES;

const iso = (date: Date): string => date.toISOString().slice(0, 10);

export const rangeToDates = (
  range: Range,
  today = new Date(),
): { from?: string; to?: string } => {
  const end = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );

  switch (range) {
    case 'all':
      return {};
    case '30d':
      return { from: iso(new Date(end.getTime() - 29 * 86_400_000)), to: iso(end) };
    case '90d':
      return { from: iso(new Date(end.getTime() - 89 * 86_400_000)), to: iso(end) };
    case 'ytd':
      return { from: `${end.getUTCFullYear()}-01-01`, to: iso(end) };
  }
};

export type RegisterFilters = {
  accountId: string | null;
  /** Passed to the API as found: a malformed or foreign id is the API's to answer. */
  projectId: string | null;
  range: Range;
  q: string;
  setAccount(id: string): void;
  setRange(range: Range): void;
  setQuery(q: string): void;
  clearProject(): void;
};

export const useRegisterFilters = (): RegisterFilters => {
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get('range');

  const patch = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  return {
    accountId: params.get('account'),
    projectId: params.get('project'),
    range: isRange(rangeParam) ? rangeParam : 'all',
    q: params.get('q') ?? '',
    setAccount: (id) => patch({ account: id }),
    setRange: (range) => patch({ range }),
    setQuery: (q) => patch({ q }),
    clearProject: () => patch({ project: '' }),
  };
};
