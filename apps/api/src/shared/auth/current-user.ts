import type { Request, RequestHandler } from 'express';

/**
 * The authentication seam. Authentication is out of scope; tenancy is not —
 * swap this middleware for real identity resolution and nothing downstream
 * moves, because every repository already scopes by the owner it puts here.
 */
export const CURRENT_USER_ID = '00000000-0000-4000-8000-00000000000a';

declare global {
  namespace Express {
    interface Request {
      ownerId?: string;
    }
  }
}

export const currentUser =
  (ownerId: string): RequestHandler =>
  (req, _res, next) => {
    req.ownerId = ownerId;
    next();
  };

export const ownerIdOf = (req: Request): string => {
  const ownerId = req.ownerId;
  if (ownerId === undefined) {
    throw new Error('currentUser middleware is not mounted');
  }
  return ownerId;
};
