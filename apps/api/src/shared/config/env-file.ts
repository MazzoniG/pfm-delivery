import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads the repository's `.env` into `process.env` for local runs, and does
 * nothing at all under docker compose, which sets the environment itself and
 * ships no `.env` in the image.
 *
 * Found by walking up from the working directory, because the Prisma CLI, the
 * dev server and the seed all run from different ones. Values already in the
 * environment win — `process.loadEnvFile` does not overwrite them — so an
 * exported variable or a compose setting still beats the file.
 */
export const loadEnvFile = (from: string = process.cwd()): string | null => {
  let dir = path.resolve(from);

  for (;;) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};
