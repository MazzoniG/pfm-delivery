import { createAccountController, type AccountController } from './modules/accounts/controller.js';
import { createAccountRepository } from './modules/accounts/repository.js';
import { createAccountService } from './modules/accounts/service.js';
import { createCategoryController, type CategoryController } from './modules/categories/controller.js';
import { createCategoryRepository } from './modules/categories/repository.js';
import { createCategoryService } from './modules/categories/service.js';
import { createAnthropicProvider } from './modules/insights/anthropic.adapter.js';
import { readInsightsConfig } from './modules/insights/config.js';
import { createInsightsController, type InsightsController } from './modules/insights/controller.js';
import { createInsightsRepository } from './modules/insights/repository.js';
import { createInsightsService } from './modules/insights/service.js';
import { createProjectController, type ProjectController } from './modules/projects/controller.js';
import { createRecurringController, type RecurringController } from './modules/recurring/controller.js';
import { createRecurringRepository } from './modules/recurring/repository.js';
import { createRecurringService, type RecurringService } from './modules/recurring/service.js';
import { createProjectRepository } from './modules/projects/repository.js';
import { createProjectService } from './modules/projects/service.js';
import { createReportingController, type ReportingController } from './modules/reporting/controller.js';
import { createReportingService } from './modules/reporting/service.js';
import { createEntryController, type EntryController } from './modules/transactions/controller.js';
import { createEntryRepository } from './modules/transactions/repository.js';
import { createEntryService } from './modules/transactions/service.js';
import { CURRENT_USER_ID } from './shared/auth/current-user.js';
import { createDb, type Db } from './shared/db/prisma.js';
import { createLogger, type Logger } from './shared/logging/logger.js';

export type Container = {
  db: Db;
  log: Logger;
  currentUserId: string;
  accounts: AccountController;
  categories: CategoryController;
  entries: EntryController;
  projects: ProjectController;
  reporting: ReportingController;
  insights: InsightsController;
  recurring: RecurringController;
  /** Shared: the projection expands occurrences before it reads them. */
  recurringService: RecurringService;
};

export const createContainer = (): Container => {
  const log = createLogger();
  const db = createDb();
  // Shared: paying a bill posts an ordinary entry through the entry service
  // rather than through a second write path of its own.
  const entries = createEntryService(createEntryRepository(db));
  const recurringService = createRecurringService(
    createRecurringRepository(db),
    entries,
  );
  // Built after `recurringService`, and in that order deliberately: the
  // projection materialises occurrences before reading them, so reporting
  // depends on recurring and nothing depends the other way. Shared, because the
  // insights module reads its ranked merchants through this service rather than
  // reaching into the reporting module's queries.
  const reporting = createReportingService(db, recurringService);

  return {
    db,
    log,
    currentUserId: CURRENT_USER_ID,
    accounts: createAccountController(
      createAccountService(createAccountRepository(db)),
    ),
    categories: createCategoryController(
      createCategoryService(createCategoryRepository(db)),
    ),
    entries: createEntryController(entries),
    projects: createProjectController(
      createProjectService(createProjectRepository(db)),
    ),
    reporting: createReportingController(reporting),
    insights: createInsightsController(
      createInsightsService(
        reporting,
        createInsightsRepository(db),
        createAnthropicProvider(readInsightsConfig(), log),
        log,
      ),
    ),
    recurring: createRecurringController(recurringService),
    recurringService,
  };
};
