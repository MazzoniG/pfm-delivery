import { Router } from 'express';
import {
  routes,
  SpendingReportRequest,
  UpdateInsightsSettingsRequest,
} from '@pfm/contracts';
import { validate } from '../../shared/middleware/validate.js';
import type { InsightsController } from './controller.js';

export const insightsRoutes = (insights: InsightsController): Router => {
  const router = Router();

  /**
   * A POST for a report, because generating one is an action with a cost: it is
   * what may call a paid model, and it is what records that names were sent.
   */
  router.post(
    routes.insightsSpendingReport,
    validate(SpendingReportRequest),
    insights.spendingReport,
  );

  router.get(routes.insightsSettings, insights.settings);

  // PUT, not POST: consent is one value with two states, and setting it twice
  // has to mean what setting it once meant.
  router.put(
    routes.insightsSettings,
    validate(UpdateInsightsSettingsRequest),
    insights.updateSettings,
  );

  return router;
};
