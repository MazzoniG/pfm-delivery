import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { RequestHandler } from 'express';
import { PROBLEM_CONTENT_TYPE } from '@pfm/contracts';
import { createApp } from './app.js';
import type { Container } from './container.js';
import { CURRENT_USER_ID } from './shared/auth/current-user.js';
import type { Db } from './shared/db/prisma.js';
import { closeServer, listenOnLoopback } from './test/loopback.js';

// Owner scoping is unobservable over HTTP until a route reads it, so the spy
// stands in for the repositories that will. Without it, deleting the mount in
// app.ts leaves the whole suite green.
const spy = vi.hoisted(() => ({ mountedWith: [] as string[] }));

vi.mock('./shared/auth/current-user.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./shared/auth/current-user.js')>();
  return {
    ...actual,
    currentUser:
      (ownerId: string): RequestHandler =>
      (req, _res, next) => {
        spy.mountedWith.push(ownerId);
        req.ownerId = ownerId;
        next();
      },
  };
});

// These routes have their own tests against a real database; here they only
// have to exist, so the mount in app.ts is covered without a Prisma client.
const unreachable: RequestHandler = () => {
  throw new Error('route not exercised by the skeleton tests');
};

const stubContainer = (): Container => ({
  db: {} as Db,
  log: { error: () => {}, info: () => {} } as unknown as Container['log'],
  currentUserId: CURRENT_USER_ID,
  accounts: {
    list: unreachable,
    create: unreachable,
    rename: unreachable,
    archive: unreachable,
  },
  categories: { list: unreachable },
  projects: { create: unreachable, rename: unreachable, remove: unreachable },
  entries: {
    list: unreachable,
    find: unreachable,
    create: unreachable,
    update: unreachable,
    remove: unreachable,
    correct: unreachable,
  },
  reporting: {
    balances: unreachable,
    accountBalance: unreachable,
    categoryReport: unreachable,
    categoryLines: unreachable,
    projects: unreachable,
    projectReport: unreachable,
    projection: unreachable,
  },
  insights: {
    spendingReport: unreachable,
    settings: unreachable,
    updateSettings: unreachable,
  },
  recurring: { create: unreachable, pay: unreachable },
  recurringService: {
    createSeries: unreachable,
    expandThrough: unreachable,
    pay: unreachable,
  } as unknown as Container['recurringService'],
});

const get = async (path: string): Promise<request.Response> => {
  const server = await listenOnLoopback(createApp(stubContainer()));
  try {
    return await request(server).get(path);
  } finally {
    await closeServer(server);
  }
};

describe('api skeleton', () => {
  it('serves liveness without touching the database', async () => {
    const res = await get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns RFC 9457 problem+json for an unknown route', async () => {
    const res = await get('/api/v1/nope');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(res.body).toMatchObject({
      type: expect.stringContaining('not-found'),
      title: expect.any(String),
      status: 404,
      instance: '/api/v1/nope',
    });
  });

  it('runs currentUser on every request, with the container id', async () => {
    spy.mountedWith.length = 0;

    await get('/health');

    expect(spy.mountedWith).toEqual([CURRENT_USER_ID]);
  });
});
