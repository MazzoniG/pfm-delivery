import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

const run = promisify(execFile);

const apiRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const prismaCli = path.join(apiRoot, 'node_modules/.bin/prisma');

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
  }
}

// A real Postgres, migrated and seeded exactly the way a cold start does it.
// A mocked client cannot prove a deferrable constraint trigger fires at COMMIT.
export default async function setup({
  provide,
}: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer(
    'postgres:18.6-alpine',
  ).start();

  const databaseUrl = container.getConnectionUri();
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    SEED_ON_START: 'true',
  };

  await run(prismaCli, ['migrate', 'deploy'], { cwd: apiRoot, env });
  await run(prismaCli, ['db', 'seed'], { cwd: apiRoot, env });

  provide('databaseUrl', databaseUrl);

  return async () => {
    await container.stop();
  };
}
