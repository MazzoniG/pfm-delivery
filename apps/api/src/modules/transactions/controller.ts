import type { RequestHandler } from 'express';
import type {
  CreateCorrectionRequest,
  CreateEntryRequest,
  EntryListQuery,
  TransactionPageWire,
  UpdateEntryRequest,
} from '@pfm/contracts';
import { ownerIdOf } from '../../shared/auth/current-user.js';
import { validated } from '../../shared/middleware/validate.js';
import { toEntry, toRowViews } from './mapper.js';
import type { EntryService } from './service.js';

type IdParam = { id: string };

export type EntryController = {
  list: RequestHandler;
  find: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
  correct: RequestHandler;
};

export const createEntryController = (
  entries: EntryService,
): EntryController => ({
  list: async (req, res) => {
    const query = validated<EntryListQuery>(req, 'query');
    const { rows, nextCursor, projectEntriesInOtherAccounts } = await entries.page(
      ownerIdOf(req),
      query,
    );

    const body: TransactionPageWire = {
      data: rows.flatMap((row) => toRowViews(row, query.accountId, query.projectId)),
      nextCursor,
      ...(projectEntriesInOtherAccounts !== undefined ? { projectEntriesInOtherAccounts } : {}),
    };
    res.json(body);
  },

  find: async (req, res) => {
    const { id } = validated<IdParam>(req, 'params');
    res.json(toEntry(await entries.find(ownerIdOf(req), id)));
  },

  create: async (req, res) => {
    const input = validated<CreateEntryRequest>(req);
    const entry = await entries.create(ownerIdOf(req), input);
    res.status(201).json(toEntry(entry));
  },

  update: async (req, res) => {
    const { id } = validated<IdParam>(req, 'params');
    const patch = validated<UpdateEntryRequest>(req);
    res.json(toEntry(await entries.update(ownerIdOf(req), id, patch)));
  },

  remove: async (req, res) => {
    const { id } = validated<IdParam>(req, 'params');
    await entries.remove(ownerIdOf(req), id);
    res.status(204).send();
  },

  correct: async (req, res) => {
    const { id } = validated<IdParam>(req, 'params');
    const { replacement } = validated<CreateCorrectionRequest>(req);
    const result = await entries.correct(ownerIdOf(req), id, replacement);

    res.status(201).json({
      original: toEntry(result.original),
      reversal: toEntry(result.reversal),
      replacement: toEntry(result.replacement),
    });
  },
});
