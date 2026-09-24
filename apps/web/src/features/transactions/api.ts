import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  CorrectionResponse,
  Entry,
  TransactionPage,
  routes,
  type CorrectionReplacementWire,
  type CreateEntryRequestWire,
  type UpdateEntryRequestWire,
} from '@pfm/contracts';
import { request } from '../../lib/api.js';

export type RegisterQuery = {
  accountId: string;
  projectId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
};

const toSearch = ({ accountId, projectId, from, to, q }: RegisterQuery, cursor?: string) => {
  const params = new URLSearchParams({ accountId });
  if (projectId) params.set('projectId', projectId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
};

export const useTransactions = (query: RegisterQuery | null) =>
  useInfiniteQuery({
    // The key is the filter set, so a changed URL is a changed query and the
    // cache never serves one account's register for another's.
    queryKey: ['entries', query],
    enabled: query !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      TransactionPage.parse(
        await request(`${routes.entries}?${toSearch(query!, pageParam)}`),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** A posted, edited or corrected entry moves a balance and a report, so every cache over the ledger goes. */
const refreshLedger = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: ['entries'] }),
    client.invalidateQueries({ queryKey: ['balances'] }),
    client.invalidateQueries({ queryKey: ['reports'] }),
    client.invalidateQueries({ queryKey: ['projects'] }),
  ]);

export const useEntry = (id: string | null) =>
  useQuery({
    queryKey: ['entry', id],
    enabled: id !== null,
    queryFn: async () => Entry.parse(await request(routes.entry(id!))),
  });

export const useCreateEntry = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateEntryRequestWire) =>
      Entry.parse(
        await request(routes.entries, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      ),
    onSuccess: () => refreshLedger(client),
  });
};

export const useUpdateEntry = (entryId: string | null) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (patch: UpdateEntryRequestWire) =>
      Entry.parse(
        await request(routes.entry(entryId!), {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }),
      ),
    onSuccess: () => refreshLedger(client),
  });
};

export const usePostCorrection = (entryId: string | null) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (replacement: CorrectionReplacementWire) =>
      CorrectionResponse.parse(
        await request(routes.entryCorrection(entryId!), {
          method: 'POST',
          body: JSON.stringify({ replacement }),
        }),
      ),
    onSuccess: () => refreshLedger(client),
  });
};
