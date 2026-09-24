import type { ErrorRequestHandler } from 'express';
import { PROBLEM_CONTENT_TYPE, type ProblemDetails } from '@pfm/contracts';
import {
  AppError,
  MalformedJsonError,
  PayloadTooLargeError,
  ValidationError,
} from '../errors/app-error.js';
import type { Logger } from '../logging/logger.js';

type BodyParserError = { type?: unknown; limit?: unknown };

// express.json rejects before any route runs. Its own message quotes the body
// back, so only its `type` is read and the detail is written here.
const fromBodyParser = (err: unknown): AppError | null => {
  const { type, limit } = (err ?? {}) as BodyParserError;
  if (type === 'entity.parse.failed') {
    return new MalformedJsonError('Malformed JSON', 'The request body is not valid JSON.');
  }
  if (type === 'entity.too.large') {
    const bound = typeof limit === 'number' ? ` of ${limit} bytes` : '';
    return new PayloadTooLargeError(
      'Payload too large',
      `The request body exceeds the limit${bound}.`,
    );
  }
  return null;
};

export const errorHandler =
  (log: Logger): ErrorRequestHandler =>
  (raw, req, res, _next) => {
    const err: unknown = fromBodyParser(raw) ?? raw;
    const problem: ProblemDetails =
      err instanceof AppError
        ? {
            type: err.type,
            title: err.title,
            status: err.status,
            ...(err.detail !== undefined ? { detail: err.detail } : {}),
            instance: req.originalUrl,
            ...(err instanceof ValidationError
              ? { errors: [...err.issues] }
              : {}),
            ...err.extensions,
          }
        : {
            type: 'https://pfm.local/problems/internal',
            title: 'Internal server error',
            status: 500,
            instance: req.originalUrl,
          };

    if (problem.status >= 500) {
      log.error({ err }, 'unhandled error');
    }

    res.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(problem);
  };
