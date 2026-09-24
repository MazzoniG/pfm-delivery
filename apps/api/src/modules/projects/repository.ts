import { Prisma } from '@prisma/client';
import { ConflictError } from '../../shared/errors/app-error.js';
import type { Db } from '../../shared/db/prisma.js';

export type ProjectRow = { id: string; name: string; createdAt: Date };

export type DeleteOutcome =
  | { kind: 'deleted' }
  | { kind: 'missing' }
  | { kind: 'in-use'; transactionCount: number };

export type ProjectRepository = {
  findById(ownerId: string, id: string): Promise<ProjectRow | null>;
  create(ownerId: string, name: string): Promise<ProjectRow>;
  rename(ownerId: string, id: string, name: string): Promise<ProjectRow | null>;
  delete(ownerId: string, id: string): Promise<DeleteOutcome>;
};

const columns = { id: true, name: true, createdAt: true } as const;

const isNameTaken = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const isStillReferenced = (error: unknown): boolean =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') ||
  (error as { meta?: { driverAdapterError?: { cause?: { code?: string } } } })?.meta
    ?.driverAdapterError?.cause?.code === '23503';

const rejectDuplicateName = async <T>(name: string, write: () => Promise<T>): Promise<T> => {
  try {
    return await write();
  } catch (error) {
    if (isNameTaken(error)) {
      throw new ConflictError(
        'Project name already in use',
        `A project named "${name}" already exists.`,
      );
    }
    throw error;
  }
};

export const createProjectRepository = (db: Db): ProjectRepository => {
  const findById: ProjectRepository['findById'] = (ownerId, id) =>
    db.project.findFirst({ where: { ownerId, id }, select: columns });

  // Every entry holding a line on the project, excluded lines included: this
  // counts what blocks the delete, not what the project costs.
  const referencingEntries = (ownerId: string, projectId: string): Promise<number> =>
    db.entry.count({
      where: { ownerId, lines: { some: { projectId } } },
    });

  const attemptDelete = async (ownerId: string, id: string): Promise<DeleteOutcome> => {
    try {
      const { count } = await db.project.deleteMany({ where: { ownerId, id } });
      return count === 0 ? { kind: 'missing' } : { kind: 'deleted' };
    } catch (error) {
      if (!isStillReferenced(error)) throw error;
      return { kind: 'in-use', transactionCount: await referencingEntries(ownerId, id) };
    }
  };

  return {
    findById,

    create: (ownerId, name) =>
      rejectDuplicateName(name, () =>
        db.project.create({ data: { ownerId, name }, select: columns }),
      ),

    rename: (ownerId, id, name) =>
      rejectDuplicateName(name, async () => {
        const { count } = await db.project.updateMany({
          where: { ownerId, id },
          data: { name },
        });
        return count === 0 ? null : findById(ownerId, id);
      }),

    // No pre-check: the FK's RESTRICT decides, because a line can be assigned
    // between any check and the delete. A count of zero after a violation means
    // the referencing lines went away in between, so the delete is retried once.
    delete: async (ownerId, id) => {
      const first = await attemptDelete(ownerId, id);
      if (first.kind !== 'in-use' || first.transactionCount > 0) return first;
      return attemptDelete(ownerId, id);
    },
  };
};
