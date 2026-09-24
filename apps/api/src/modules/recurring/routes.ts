import { Router } from 'express';
import {
  CreateRecurringSeriesRequest,
  OccurrenceIdParam,
  PayOccurrenceRequest,
  routes,
} from '@pfm/contracts';
import { validate } from '../../shared/middleware/validate.js';
import type { RecurringController } from './controller.js';

// `GET /projection` is a reporting query and is mounted with that module.
export const recurringRoutes = (recurring: RecurringController): Router => {
  const router = Router();

  router.post(
    routes.recurring,
    validate(CreateRecurringSeriesRequest),
    recurring.create,
  );
  router.post(
    routes.occurrencePay(':id'),
    validate(OccurrenceIdParam, 'params'),
    validate(PayOccurrenceRequest),
    recurring.pay,
  );

  return router;
};
