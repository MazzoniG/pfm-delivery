import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

type RequestContext = { requestId: string };

const storage = new AsyncLocalStorage<RequestContext>();

export const createLogger = (level = process.env['LOG_LEVEL'] ?? 'info'): Logger =>
  pino({
    level,
    mixin: () => ({ requestId: storage.getStore()?.requestId }),
  });

export const requestContext: RequestHandler = (req, res, next) => {
  const requestId = req.header('x-request-id') ?? randomUUID();
  res.setHeader('x-request-id', requestId);
  storage.run({ requestId }, next);
};
