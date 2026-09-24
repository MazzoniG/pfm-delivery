import type { RequestHandler } from 'express';
import type {
  CreateRecurringSeriesRequest,
  PayOccurrenceRequest,
} from '@pfm/contracts';
import { ownerIdOf } from '../../shared/auth/current-user.js';
import { validated } from '../../shared/middleware/validate.js';
import { toEntry } from '../transactions/mapper.js';
import { toRecurringSeries, toScheduledOccurrence } from './mapper.js';
import type { RecurringService } from './service.js';

type IdParam = { id: string };

export type RecurringController = {
  create: RequestHandler;
  pay: RequestHandler;
};

export const createRecurringController = (
  recurring: RecurringService,
): RecurringController => ({
  create: async (req, res) => {
    const input = validated<CreateRecurringSeriesRequest>(req);
    const series = await recurring.createSeries(ownerIdOf(req), input);
    res.status(201).json(toRecurringSeries(series));
  },

  // 201: the resource this creates is the transaction, not the link.
  pay: async (req, res) => {
    const { id } = validated<IdParam>(req, 'params');
    const input = validated<PayOccurrenceRequest>(req);
    const { occurrence, entry } = await recurring.pay(
      ownerIdOf(req),
      id,
      input,
    );
    res.status(201).json({
      occurrence: toScheduledOccurrence(occurrence),
      entry: toEntry(entry),
    });
  },
});
