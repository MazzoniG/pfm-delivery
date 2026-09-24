import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { CURRENT_USER_ID } from '../src/shared/auth/current-user.js';
import { loadEnvFile } from '../src/shared/config/env-file.js';
import { buildDemoTenant, type Tenant } from './seed/demo-tenant.js';
import { buildDecoyTenant } from './seed/decoy-tenant.js';
import { todayUtc } from './seed/time.js';

const log = (message: string): void => console.log(`[seed] ${message}`);

loadEnvFile();

const connectionString = process.env['DATABASE_URL'] ?? '';
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const writeTenant = async (
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>,
  tenant: Tenant,
): Promise<void> => {
  await tx.user.create({ data: tenant.user });
  await tx.ledgerAccount.createMany({ data: tenant.accounts });
  if (tenant.projects.length > 0) {
    await tx.project.createMany({ data: tenant.projects });
  }

  // Rules, not occurrences, and nothing in the ledger: a scheduled bill has not
  // happened yet. Expansion fills `scheduled_occurrences` on demand.
  await tx.recurringSeries.createMany({ data: tenant.recurring });

  // Entries land before their lines, so every one of them is momentarily
  // unbalanced. The zero-sum trigger is deferred to COMMIT precisely so this
  // ordinary way of writing a ledger is possible at all.
  await tx.entry.createMany({ data: tenant.entries });
  await tx.entryLine.createMany({ data: tenant.lines });

  if (tenant.reconcile) {
    const { from, to, at } = tenant.reconcile;
    const filed = await tx.entry.findMany({
      where: { ownerId: tenant.ownerId, occurredOn: { gte: from, lte: to } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const ids = filed.map((entry) => entry.id);

    // Lines first, entry last. After `locked_at` is set nothing in the entry
    // can be written again, and the lock trigger has no exemption to lean on.
    await tx.entryLine.updateMany({
      where: { entryId: { in: ids } },
      data: { reconciledAt: at },
    });
    await tx.entry.updateMany({
      where: { id: { in: ids } },
      data: { lockedAt: at },
    });
    log(`reconciled ${ids.length} entries in the filed month`);
  }

  if (tenant.corrections.entries.length > 0) {
    await tx.entry.createMany({ data: tenant.corrections.entries });
    await tx.entryLine.createMany({ data: tenant.corrections.lines });
  }
};

const main = async (): Promise<void> => {
  if (process.env['SEED_ON_START'] !== 'true') {
    log('SEED_ON_START is not "true" — refusing to seed. This is the gate.');
    return;
  }

  const seeded = await db.user.count();
  if (seeded > 0) {
    log(`already seeded (${seeded} users) — nothing to do`);
    return;
  }

  const anchor = todayUtc();
  const demo = buildDemoTenant(CURRENT_USER_ID, anchor);
  const decoy = buildDecoyTenant(anchor);

  await db.$transaction(
    async (tx) => {
      await writeTenant(tx, demo);
      await writeTenant(tx, decoy);
    },
    { timeout: 120_000, maxWait: 15_000 },
  );

  log(`anchored on ${anchor.toISOString().slice(0, 10)}`);
  log(
    `demo tenant: ${demo.accounts.length} ledger accounts, ` +
      `${demo.entries.length + demo.corrections.entries.length} entries, ` +
      `${demo.lines.length + demo.corrections.lines.length} lines`,
  );
  log(
    `decoy tenant: ${decoy.accounts.length} ledger accounts, ` +
      `${decoy.entries.length} entries, ${decoy.projects.length} project`,
  );
  log(
    `recurring series: ${demo.recurring.length} for the demo tenant, ` +
      `${decoy.recurring.length} for the decoy — no occurrences, none in the ledger`,
  );
};

try {
  await main();
} catch (error) {
  console.error('[seed] failed', error);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
