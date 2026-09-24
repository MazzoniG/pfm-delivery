import { describe, expect, it } from 'vitest';
import express, { type Express, type Request } from 'express';
import request from 'supertest';
import { closeServer, listenOnLoopback } from '../../test/loopback.js';
import { CURRENT_USER_ID, currentUser, ownerIdOf } from './current-user.js';

const probe = async (
  app: Express,
  headers: Record<string, string> = {},
): Promise<request.Response> => {
  const server = await listenOnLoopback(app);
  try {
    return await request(server).get('/probe').set(headers);
  } finally {
    await closeServer(server);
  }
};

describe('currentUser', () => {
  it('places the stub owner on the request for every handler downstream', async () => {
    const app = express();
    app.use(currentUser(CURRENT_USER_ID));
    app.get('/probe', (req, res) => res.json({ ownerId: ownerIdOf(req) }));

    const res = await probe(app);

    expect(res.body.ownerId).toBe(CURRENT_USER_ID);
  });

  it('ignores a client-supplied X-User-Id', async () => {
    const app = express();
    app.use(currentUser(CURRENT_USER_ID));
    app.get('/probe', (req, res) => res.json({ ownerId: ownerIdOf(req) }));

    const res = await probe(app, { 'X-User-Id': 'someone-else' });

    expect(res.body.ownerId).toBe(CURRENT_USER_ID);
  });

  it('fails loudly rather than silently unscoped when not mounted', () => {
    expect(() => ownerIdOf({} as Request)).toThrow(/not mounted/);
  });
});
