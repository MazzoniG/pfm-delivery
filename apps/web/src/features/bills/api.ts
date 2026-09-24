import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  PayOccurrenceResponse,
  ProjectionResponse,
  RecurringSeries,
  routes,
  type CreateRecurringSeriesRequestWire,
  type PayOccurrenceRequestWire,
} from '@pfm/contracts';
import { request } from '../../lib/api.js';

/**
 * Paying a bill posts a real entry, so every cache over the ledger goes with
 * it — the same set the register invalidates, plus the projection the bill just
 * left. Scheduling one touches no balance, but it does change the forecast.
 */
const refreshForecast = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: ['projection'] });

const refreshLedgerAndForecast = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: ['entries'] }),
    client.invalidateQueries({ queryKey: ['balances'] }),
    client.invalidateQueries({ queryKey: ['reports'] }),
    client.invalidateQueries({ queryKey: ['projects'] }),
    refreshForecast(client),
  ]);

/** Keyed on the horizon, so moving the segmented control back costs no request. */
export const useProjection = (to: string) =>
  useQuery({
    queryKey: ['projection', to],
    queryFn: async () =>
      ProjectionResponse.parse(await request(`${routes.projection}?to=${to}`)),
  });

export const useCreateSeries = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateRecurringSeriesRequestWire) =>
      RecurringSeries.parse(
        await request(routes.recurring, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      ),
    onSuccess: () => refreshForecast(client),
  });
};

export const usePayOccurrence = (occurrenceId: string | null) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: PayOccurrenceRequestWire) =>
      PayOccurrenceResponse.parse(
        await request(routes.occurrencePay(occurrenceId ?? ''), {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      ),
    onSuccess: () => refreshLedgerAndForecast(client),
  });
};
