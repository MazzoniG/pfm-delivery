import { useQuery } from '@tanstack/react-query';
import { CategoryLines, CategoryReport, routes } from '@pfm/contracts';
import { request } from '../../lib/api.js';

/** Keyed on the period only: choosing a month is a lookup in this response. */
export const useCategoryReport = (from: string, to: string) =>
  useQuery({
    queryKey: ['reports', 'categories', from, to],
    queryFn: async () =>
      CategoryReport.parse(
        await request(`${routes.categoryReport}?${new URLSearchParams({ from, to })}`),
      ),
  });

export const useCategoryLines = (ledgerAccountId: string, from: string, to: string) =>
  useQuery({
    queryKey: ['reports', 'category-lines', ledgerAccountId, from, to],
    queryFn: async () =>
      CategoryLines.parse(
        await request(
          `${routes.categoryReportLines(ledgerAccountId)}?${new URLSearchParams({ from, to })}`,
        ),
      ),
  });
