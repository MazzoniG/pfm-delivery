import { Router } from 'express';
import {
  AccountIdParam,
  CreateAccountRequest,
  UpdateAccountRequest,
  routes,
} from '@pfm/contracts';
import { validate } from '../../shared/middleware/validate.js';
import type { AccountController } from './controller.js';

export const accountRoutes = (accounts: AccountController): Router => {
  const router = Router();
  const collection = routes.accounts;
  const item = `${routes.accounts}/:id`;

  router.get(collection, accounts.list);
  router.post(collection, validate(CreateAccountRequest), accounts.create);
  router.patch(
    item,
    validate(AccountIdParam, 'params'),
    validate(UpdateAccountRequest),
    accounts.rename,
  );
  router.delete(item, validate(AccountIdParam, 'params'), accounts.archive);

  return router;
};
