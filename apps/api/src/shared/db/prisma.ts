import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export type Db = PrismaClient;

export const createDb = (
  connectionString = process.env['DATABASE_URL'] ?? '',
): Db => new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

export const pingDb = async (db: Db): Promise<boolean> => {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
};
