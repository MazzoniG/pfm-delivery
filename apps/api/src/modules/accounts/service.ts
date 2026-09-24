import type { CreateAccountRequest, UpdateAccountRequest } from '@pfm/contracts';
import { NotFoundError } from '../../shared/errors/app-error.js';
import type { AccountRepository, AccountRow } from './repository.js';

export type AccountService = {
  list(ownerId: string): Promise<AccountRow[]>;
  create(ownerId: string, input: CreateAccountRequest): Promise<AccountRow>;
  rename(ownerId: string, id: string, input: UpdateAccountRequest): Promise<AccountRow>;
  archive(ownerId: string, id: string): Promise<void>;
};

/**
 * Ownership is enforced by the `WHERE` clause rather than by a check after the
 * read, so a row belonging to someone else is indistinguishable from one that
 * does not exist — 404, never 403. A 403 would confirm the id is real.
 */
const missing = (id: string): NotFoundError =>
  new NotFoundError('Account not found', `No account with id ${id}.`);

export const createAccountService = (
  accounts: AccountRepository,
  now: () => Date = () => new Date(),
): AccountService => ({
  list: (ownerId) => accounts.listLive(ownerId),

  create: (ownerId, input) => accounts.create(ownerId, input),

  rename: async (ownerId, id, input) => {
    const renamed = await accounts.rename(ownerId, id, input.name);
    if (!renamed) throw missing(id);
    return renamed;
  },

  archive: async (ownerId, id) => {
    // Archiving an already-archived account is the state the caller asked for,
    // so it is a 204 rather than an error. Only a row this owner cannot see
    // is a 404.
    const existing = await accounts.findById(ownerId, id);
    if (!existing) throw missing(id);
    if (existing.archivedAt) return;

    await accounts.archive(ownerId, id, now());
  },
});
