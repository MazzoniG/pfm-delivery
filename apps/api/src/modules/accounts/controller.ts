import type { RequestHandler } from 'express';
import type { CreateAccountRequest, UpdateAccountRequest } from '@pfm/contracts';
import { ownerIdOf } from '../../shared/auth/current-user.js';
import { validated } from '../../shared/middleware/validate.js';
import { toLedgerAccount } from './mapper.js';
import type { AccountService } from './service.js';

type IdParam = { id: string };

export type AccountController = {
  list: RequestHandler;
  create: RequestHandler;
  rename: RequestHandler;
  archive: RequestHandler;
};

export const createAccountController = (
  accounts: AccountService,
): AccountController => ({
  list: async (req, res) => {
    const rows = await accounts.list(ownerIdOf(req));
    res.json(rows.map(toLedgerAccount));
  },

  create: async (req, res) => {
    const input = validated<CreateAccountRequest>(req);
    const row = await accounts.create(ownerIdOf(req), input);
    res.status(201).json(toLedgerAccount(row));
  },

  rename: async (req, res) => {
    const { id } = validated<IdParam>(req, 'params');
    const input = validated<UpdateAccountRequest>(req);
    const row = await accounts.rename(ownerIdOf(req), id, input);
    res.json(toLedgerAccount(row));
  },

  archive: async (req, res) => {
    const { id } = validated<IdParam>(req, 'params');
    await accounts.archive(ownerIdOf(req), id);
    res.status(204).send();
  },
});
