import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  InsightsSettings,
  SpendingReport,
  routes,
  type GroupingMode,
} from '@pfm/contracts';
import { request } from '../../lib/api.js';

const SETTINGS_KEY = ['insights', 'settings'] as const;

export const useInsightsSettings = () =>
  useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => InsightsSettings.parse(await request(routes.insightsSettings)),
  });

/**
 * Consent, and its withdrawal. The answer replaces the cached settings rather
 * than invalidating them, so the switch never flickers through its old state on
 * the way to its new one.
 */
export const useSetConsent = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) =>
      InsightsSettings.parse(
        await request(routes.insightsSettings, {
          method: 'PUT',
          body: JSON.stringify({ enabled }),
        }),
      ),
    onSuccess: (settings) => queryClient.setQueryData(SETTINGS_KEY, settings),
  });
};

/**
 * `enabled` is the button: nothing is requested until the user asks for a
 * report, which is also what keeps the page from calling a paid model on a
 * visit. Once asked, changing the grouping re-asks under a new key, so the
 * switch does not need its own button.
 *
 * A POST behind `useQuery` is deliberate. Generating is a costly action, which
 * is why the API makes it a POST; from the client's side it is still a read of
 * one period, and the retry, caching and pending states are the ones every
 * other view here uses.
 */
export const useSpendingReport = (
  from: string,
  to: string,
  grouping: GroupingMode,
  enabled: boolean,
) =>
  useQuery({
    queryKey: ['insights', 'spending-report', from, to, grouping],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async () =>
      SpendingReport.parse(
        await request(routes.insightsSpendingReport, {
          method: 'POST',
          body: JSON.stringify({ from, to, grouping }),
        }),
      ),
  });
