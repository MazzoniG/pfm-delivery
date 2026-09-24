import type { RequestHandler } from 'express';
import { NotFoundError } from '../errors/app-error.js';

export const notFound: RequestHandler = (req, _res, next) => {
  next(new NotFoundError('Route not found', `No route for ${req.method} ${req.originalUrl}`));
};
