import type { Project } from '@pfm/contracts';
import type { ProjectRow } from './repository.js';

export const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
});
