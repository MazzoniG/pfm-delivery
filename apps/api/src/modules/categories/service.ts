import type { CategoryKind } from '@pfm/contracts';
import type { CategoryRepository, CategoryRow } from './repository.js';

export type CategoryService = {
  list(ownerId: string, kind?: CategoryKind): Promise<CategoryRow[]>;
};

export const createCategoryService = (
  categories: CategoryRepository,
): CategoryService => ({
  list: (ownerId, kind) => categories.listLive(ownerId, kind),
});
