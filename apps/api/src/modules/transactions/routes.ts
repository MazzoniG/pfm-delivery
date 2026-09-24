import { Router } from 'express';
import {
  CreateCorrectionRequest,
  CreateEntryRequest,
  EntryIdParam,
  EntryListQuery,
  UpdateEntryRequest,
  routes,
} from '@pfm/contracts';
import { validate } from '../../shared/middleware/validate.js';
import type { EntryController } from './controller.js';

export const entryRoutes = (entries: EntryController): Router => {
  const router = Router();
  const collection = routes.entries;
  const item = `${routes.entries}/:id`;

  router.get(collection, validate(EntryListQuery, 'query'), entries.list);
  router.post(collection, validate(CreateEntryRequest), entries.create);

  router.get(item, validate(EntryIdParam, 'params'), entries.find);
  router.patch(
    item,
    validate(EntryIdParam, 'params'),
    validate(UpdateEntryRequest),
    entries.update,
  );
  router.delete(item, validate(EntryIdParam, 'params'), entries.remove);

  // Not a second way to edit: the only way, once an entry is reconciled.
  router.post(
    `${item}/correction`,
    validate(EntryIdParam, 'params'),
    validate(CreateCorrectionRequest),
    entries.correct,
  );

  return router;
};
