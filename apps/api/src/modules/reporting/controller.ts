import type { RequestHandler } from 'express';
import type {
  AccountIdParam,
  BalanceQuery,
  CategoryIdParam,
  CategoryLinesQuery,
  CategoryReportQuery,
  ProjectIdParam,
  ProjectionQuery,
  ProjectReportQuery,
} from '@pfm/contracts';
import { ownerIdOf } from '../../shared/auth/current-user.js';
import { validated } from '../../shared/middleware/validate.js';
import {
  toAccountBalanceResponse,
  toBalancesResponse,
  toCategoryLines,
  toCategoryReport,
  toProjection,
  toProjectList,
  toProjectReport,
} from './mapper.js';
import type { ReportingService } from './service.js';

export type ReportingController = {
  balances: RequestHandler;
  accountBalance: RequestHandler;
  categoryReport: RequestHandler;
  categoryLines: RequestHandler;
  projects: RequestHandler;
  projectReport: RequestHandler;
  projection: RequestHandler;
};

export const createReportingController = (
  reporting: ReportingService,
): ReportingController => ({
  balances: async (req, res) => {
    const { asOf } = validated<BalanceQuery>(req, 'query');
    const { asOf: on, rows } = await reporting.balances(ownerIdOf(req), asOf);
    res.json(toBalancesResponse(on, rows));
  },

  accountBalance: async (req, res) => {
    const { id } = validated<AccountIdParam>(req, 'params');
    const { asOf } = validated<BalanceQuery>(req, 'query');
    const result = await reporting.accountBalance(ownerIdOf(req), id, asOf);
    res.json(toAccountBalanceResponse(result.asOf, result.row));
  },

  categoryReport: async (req, res) => {
    const filter = validated<CategoryReportQuery>(req, 'query');
    const rows = await reporting.categoryMonthly(ownerIdOf(req), filter);
    res.json(toCategoryReport(filter, rows));
  },

  categoryLines: async (req, res) => {
    const { ledgerAccountId } = validated<CategoryIdParam>(req, 'params');
    const filter = validated<CategoryLinesQuery>(req, 'query');
    const rows = await reporting.categoryLines(ownerIdOf(req), ledgerAccountId, filter);
    res.json(toCategoryLines(ledgerAccountId, filter, rows));
  },

  projects: async (req, res) => {
    res.json(toProjectList(await reporting.projects(ownerIdOf(req))));
  },

  projectReport: async (req, res) => {
    const { id } = validated<ProjectIdParam>(req, 'params');
    const period = validated<ProjectReportQuery>(req, 'query');
    const result = await reporting.projectReport(ownerIdOf(req), id, period);
    res.json(toProjectReport(period, result));
  },

  projection: async (req, res) => {
    const { to } = validated<ProjectionQuery>(req, 'query');
    res.json(toProjection(await reporting.projection(ownerIdOf(req), to)));
  },
});
