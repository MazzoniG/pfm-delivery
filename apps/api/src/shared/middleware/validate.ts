import type { Request, RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { ValidationError } from '../errors/app-error.js';

type Source = 'body' | 'query' | 'params';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      validated?: Partial<Record<Source, unknown>>;
    }
  }
}

export const validate =
  <T>(schema: ZodType<T>, source: Source = 'body'): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(
        new ValidationError(
          'Request validation failed',
          result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        ),
      );
      return;
    }
    // Kept per source: a route that validates both `params` and `body` needs
    // both to survive, and the parsed value is never written back over the
    // Express-owned property it came from.
    req.validated = { ...req.validated, [source]: result.data };
    next();
  };

export const validated = <T>(req: Request, source: Source = 'body'): T => {
  const value = req.validated?.[source];
  if (value === undefined) {
    throw new Error(`no validated ${source} on the request — is validate() mounted?`);
  }
  return value as T;
};
