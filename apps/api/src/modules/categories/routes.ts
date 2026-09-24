import { Router } from 'express';
import { CategoryListQuery, routes } from '@pfm/contracts';
import { validate } from '../../shared/middleware/validate.js';
import type { CategoryController } from './controller.js';

export const categoryRoutes = (categories: CategoryController): Router => {
  const router = Router();

  router.get(
    routes.categories,
    validate(CategoryListQuery, 'query'),
    categories.list,
  );

  return router;
};
