import express, { type Express } from 'express';
import { API_PREFIX } from '@pfm/contracts';
import type { Container } from './container.js';
import { accountRoutes } from './modules/accounts/routes.js';
import { categoryRoutes } from './modules/categories/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { insightsRoutes } from './modules/insights/routes.js';
import { projectRoutes } from './modules/projects/routes.js';
import { recurringRoutes } from './modules/recurring/routes.js';
import { reportingRoutes } from './modules/reporting/routes.js';
import { entryRoutes } from './modules/transactions/routes.js';
import { currentUser } from './shared/auth/current-user.js';
import { requestContext } from './shared/logging/logger.js';
import { errorHandler } from './shared/middleware/error-handler.js';
import { notFound } from './shared/middleware/not-found.js';

export const createApp = ({
  db,
  log,
  currentUserId,
  accounts,
  categories,
  entries,
  projects,
  reporting,
  insights,
  recurring,
}: Container): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());
  app.use(requestContext);
  app.use(currentUser(currentUserId));

  app.use(healthRoutes(db));
  app.use(API_PREFIX, healthRoutes(db));
  // Ahead of the accounts router so `/accounts/balances` can never be matched
  // by a future `/accounts/:id` there, whatever order that file ends up in.
  app.use(API_PREFIX, reportingRoutes(reporting));
  app.use(API_PREFIX, accountRoutes(accounts));
  app.use(API_PREFIX, categoryRoutes(categories));
  app.use(API_PREFIX, entryRoutes(entries));
  app.use(API_PREFIX, projectRoutes(projects));
  app.use(API_PREFIX, insightsRoutes(insights));
  app.use(API_PREFIX, recurringRoutes(recurring));

  app.use(notFound);
  app.use(errorHandler(log));

  return app;
};
