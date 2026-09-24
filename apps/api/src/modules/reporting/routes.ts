import { Router } from 'express';
import {
  AccountIdParam,
  BalanceQuery,
  CategoryIdParam,
  CategoryLinesQuery,
  CategoryReportQuery,
  ProjectIdParam,
  ProjectionQuery,
  ProjectReportQuery,
  routes,
} from '@pfm/contracts';
import { validate } from '../../shared/middleware/validate.js';
import type { ReportingController } from './controller.js';

export const reportingRoutes = (reporting: ReportingController): Router => {
  const router = Router();

  // The literal segment first, and `:id` constrained to a UUID: either alone
  // would let `/accounts/balances` be read as an account id.
  router.get(
    routes.accountBalances,
    validate(BalanceQuery, 'query'),
    reporting.balances,
  );

  router.get(
    `${routes.accounts}/:id/balance`,
    validate(AccountIdParam, 'params'),
    validate(BalanceQuery, 'query'),
    reporting.accountBalance,
  );

  router.get(
    routes.categoryReport,
    validate(CategoryReportQuery, 'query'),
    reporting.categoryReport,
  );

  router.get(
    `${routes.categoryReport}/:ledgerAccountId/lines`,
    validate(CategoryIdParam, 'params'),
    validate(CategoryLinesQuery, 'query'),
    reporting.categoryLines,
  );

  // The write side of `/projects` lives in the projects module; the list is a
  // reporting query, because every figure on it is an aggregate.
  router.get(routes.projects, reporting.projects);

  router.get(
    routes.projectReport(':id'),
    validate(ProjectIdParam, 'params'),
    validate(ProjectReportQuery, 'query'),
    reporting.projectReport,
  );

  // A reporting query like the rest: it reads the ledger and adds what is
  // scheduled. The write side of scheduling lives in the recurring module.
  router.get(
    routes.projection,
    validate(ProjectionQuery, 'query'),
    reporting.projection,
  );

  return router;
};
