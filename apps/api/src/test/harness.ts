import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { Client } from 'pg';
import { DECOY_USER_ID } from '../../prisma/seed/decoy-tenant.js';
import { entryIdFor } from '../../prisma/seed/ledger.js';
import { seedId } from '../../prisma/seed/ids.js';
import { createApp } from '../app.js';
import { createContainer, type Container } from '../container.js';
import { CURRENT_USER_ID } from '../shared/auth/current-user.js';
import type { Db } from '../shared/db/prisma.js';
import { closeServer, listenOnLoopback } from './loopback.js';

/** The seeded demo tenant — the id the `currentUser` stub returns. */
export const ALICE = CURRENT_USER_ID;
/** The seeded decoy tenant. Everything it owns is named so a leak is visible. */
export const BLAKE = DECOY_USER_ID;

export type Harness = {
  db: Db;
  /** The app as the stubbed current user, which is Alice. */
  app: Server;
  /** The same app composed for another owner — the seam, not a header. */
  as(ownerId: string): Promise<Server>;
  close(): Promise<void>;
};

/** Every server is bound to 127.0.0.1 up front — see {@link listenOnLoopback}. */
export const startHarness = async (): Promise<Harness> => {
  const container: Container = createContainer();
  const servers: Server[] = [];
  const serve = async (app: Express): Promise<Server> => {
    const server = await listenOnLoopback(app);
    servers.push(server);
    return server;
  };
  const tenants = new Map<string, Promise<Server>>();

  return {
    db: container.db,
    app: await serve(createApp(container)),
    as: (ownerId) => {
      let server = tenants.get(ownerId);
      if (server === undefined) {
        server = serve(createApp({ ...container, currentUserId: ownerId }));
        tenants.set(ownerId, server);
      }
      return server;
    },
    close: async () => {
      await Promise.all(servers.map(closeServer));
      await container.db.$disconnect();
    },
  };
};

/** A raw connection, for the transaction boundaries Prisma will not expose. */
export const connectRaw = async (): Promise<Client> => {
  const client = new Client({ connectionString: process.env['DATABASE_URL'] });
  await client.connect();
  return client;
};

export const seededAccountId = (ownerId: string, key: string): string =>
  seedId(`account:${ownerId}:${key}`);

export const seededEntryId = entryIdFor;

export const BLAKE_PROJECT_ID = seedId(`project:${BLAKE}:decoy`);

export const ALICE_ACCOUNTS = {
  checking: seededAccountId(ALICE, 'checking'),
  savings: seededAccountId(ALICE, 'savings'),
  visa: seededAccountId(ALICE, 'visa'),
  openingBalances: seededAccountId(ALICE, 'opening-balances'),
  salary: seededAccountId(ALICE, 'salary'),
  groceries: seededAccountId(ALICE, 'groceries'),
  dining: seededAccountId(ALICE, 'dining'),
  household: seededAccountId(ALICE, 'household'),
} as const;

export const BLAKE_ACCOUNTS = {
  checking: seededAccountId(BLAKE, 'checking'),
  spending: seededAccountId(BLAKE, 'spending'),
  income: seededAccountId(BLAKE, 'income'),
} as const;

export const uniqueName = (prefix: string): string =>
  `${prefix} ${randomUUID().slice(0, 8)}`;

export const todayIso = (): string => new Date().toISOString().slice(0, 10);

export const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/**
 * Reconciling, in the order the domain requires: `reconciled_at` onto the lines
 * while the entry is still open, `locked_at` onto the entry last. There is no
 * reconcile endpoint in this story, and the lock has no exemption to lean on.
 */
export const reconcile = async (db: Db, entryId: string): Promise<Date> => {
  const at = new Date();
  await db.entryLine.updateMany({
    where: { entryId },
    data: { reconciledAt: at },
  });
  await db.entry.update({ where: { id: entryId }, data: { lockedAt: at } });
  return at;
};
