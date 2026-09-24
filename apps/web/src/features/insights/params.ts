import { useSearchParams } from 'react-router';
import type { GroupingMode } from '@pfm/contracts';
import { localIsoDate } from '../accounts/asOf.js';
import { monthEnd, monthStart } from '../reporting/params.js';

export type InsightsParams = {
  /** The selected month, `YYYY-MM`. */
  period: string;
  from: string;
  to: string;
  grouping: GroupingMode;
  setPeriod(period: string): void;
  setGrouping(grouping: GroupingMode): void;
};

/**
 * One month at a time, in the URL, so a report is a link. `grouping` is there
 * too: it is a decision about what the page did, and the back button should
 * return to the report that made no model call.
 *
 * Absent means the current month and name matching — neither default is written
 * into the URL, so a shared link that omits them keeps meaning what it says.
 */
export const useInsightsParams = (now: Date = new Date()): InsightsParams => {
  const [params, setParams] = useSearchParams();

  const period = params.get('period') ?? localIsoDate(now).slice(0, 7);
  const grouping: GroupingMode = params.get('grouping') === 'meaning' ? 'meaning' : 'name';

  const write = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  return {
    period,
    from: monthStart(period),
    to: monthEnd(period),
    grouping,
    setPeriod: (next) => write({ period: next }),
    setGrouping: (next) => write({ grouping: next === 'meaning' ? 'meaning' : null }),
  };
};

/** The last twelve months, newest first — the period picker's options. */
export const recentMonths = (now: Date, count = 12): string[] => {
  const months: string[] = [];
  for (let back = 0; back < count; back += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - back, 1);
    months.push(localIsoDate(date).slice(0, 7));
  }
  return months;
};
