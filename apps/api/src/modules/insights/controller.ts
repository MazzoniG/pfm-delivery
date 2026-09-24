import type { RequestHandler } from 'express';
import type {
  SpendingReportRequest,
  UpdateInsightsSettingsRequest,
} from '@pfm/contracts';
import { ownerIdOf } from '../../shared/auth/current-user.js';
import { validated } from '../../shared/middleware/validate.js';
import { toSpendingReport } from './mapper.js';
import type { InsightsService } from './service.js';

export type InsightsController = {
  spendingReport: RequestHandler;
  settings: RequestHandler;
  updateSettings: RequestHandler;
};

export const createInsightsController = (
  insights: InsightsService,
): InsightsController => ({
  spendingReport: async (req, res) => {
    const request = validated<SpendingReportRequest>(req, 'body');
    const result = await insights.spendingReport(ownerIdOf(req), request);
    res.json(toSpendingReport(request, result));
  },

  settings: async (req, res) => {
    res.json(await insights.settings(ownerIdOf(req)));
  },

  updateSettings: async (req, res) => {
    const { enabled } = validated<UpdateInsightsSettingsRequest>(req, 'body');
    res.json(await insights.setConsent(ownerIdOf(req), enabled));
  },
});
