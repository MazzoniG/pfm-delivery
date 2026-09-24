import { defineConfig } from '@prisma/config';
import { loadEnvFile } from './src/shared/config/env-file.js';

// `prisma migrate` and `prisma db seed` are run by hand as often as by the
// container entrypoint, and only the entrypoint is handed an environment.
loadEnvFile();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Prisma 7 takes the seed command from here, not from package.json.
    // The entrypoint's `prisma db seed` fails without it the moment a seed exists.
    seed: './node_modules/.bin/tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
