import { z } from 'zod';
import { Timestamp, Uuid } from './common.js';

export const CategoryKind = z.enum(['income', 'expense']);
export type CategoryKind = z.infer<typeof CategoryKind>;

export const CategoryName = z.string().trim().min(1).max(80);

/** One level. There is no `parentId`, and there never will be. */
export const Category = z.object({
  id: Uuid,
  name: CategoryName,
  kind: CategoryKind,
  isSystem: z.boolean(),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Category = z.infer<typeof Category>;

export const CategoryList = z.array(Category);

export const CategoryListQuery = z.object({ kind: CategoryKind.optional() });
export type CategoryListQuery = z.infer<typeof CategoryListQuery>;
