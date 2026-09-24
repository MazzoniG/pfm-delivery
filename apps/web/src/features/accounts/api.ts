import { useQuery } from '@tanstack/react-query';
import {
  AccountList,
  BalancesResponse,
  CategoryList,
  routes,
  type CategoryKind,
} from '@pfm/contracts';
import { request } from '../../lib/api.js';

export const useAccounts = () =>
  useQuery({
    queryKey: ['accounts'],
    queryFn: async () => AccountList.parse(await request(routes.accounts)),
  });

/**
 * Deliberately separate from `useAccounts`: names render the moment the list
 * arrives while figures shimmer in place, and a slow aggregate never holds the
 * list back. Keyed on the resolved date, so each as-of is its own cache entry
 * and switching accounts costs no request at all.
 */
export const useBalances = (asOf: string) =>
  useQuery({
    queryKey: ['balances', asOf],
    queryFn: async () =>
      BalancesResponse.parse(
        await request(`${routes.accountBalances}?asOf=${asOf}`),
      ),
  });

export const useCategories = (kind: CategoryKind) =>
  useQuery({
    queryKey: ['categories', kind],
    queryFn: async () =>
      CategoryList.parse(await request(`${routes.categories}?kind=${kind}`)),
  });
