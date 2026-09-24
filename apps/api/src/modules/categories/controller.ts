import type { RequestHandler } from 'express';
import type { CategoryListQuery } from '@pfm/contracts';
import { ownerIdOf } from '../../shared/auth/current-user.js';
import { validated } from '../../shared/middleware/validate.js';
import { toCategory } from './mapper.js';
import type { CategoryService } from './service.js';

export type CategoryController = {
  list: RequestHandler;
};

export const createCategoryController = (
  categories: CategoryService,
): CategoryController => ({
  list: async (req, res) => {
    const { kind } = validated<CategoryListQuery>(req, 'query');
    const rows = await categories.list(ownerIdOf(req), kind);
    res.json(rows.map(toCategory));
  },
});
