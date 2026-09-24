import type { ProjectSummary } from '@pfm/contracts';

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
const MONTH_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

const utc = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

/** "Jul to Sep 2026"; the year is written once when both ends share it. */
export const formatMonthSpan = (first: string, last: string): string => {
  if (first.slice(0, 7) === last.slice(0, 7)) return MONTH_YEAR.format(utc(last));
  const start = first.slice(0, 4) === last.slice(0, 4) ? MONTH.format(utc(first)) : MONTH_YEAR.format(utc(first));
  return `${start} to ${MONTH_YEAR.format(utc(last))}`;
};

export const projectActivity = (project: ProjectSummary): string => {
  if (!project.firstActivityOn || !project.lastActivityOn) return 'No transactions yet';
  const count = `${project.transactionCount} transaction${project.transactionCount === 1 ? '' : 's'}`;
  return `${count}, ${formatMonthSpan(project.firstActivityOn, project.lastActivityOn)}`;
};
