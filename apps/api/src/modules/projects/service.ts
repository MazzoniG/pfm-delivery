import type { CreateProjectRequest, UpdateProjectRequest } from '@pfm/contracts';
import { NotFoundError, ProjectInUseError } from '../../shared/errors/app-error.js';
import type { ProjectRepository, ProjectRow } from './repository.js';

export type ProjectService = {
  create(ownerId: string, input: CreateProjectRequest): Promise<ProjectRow>;
  rename(ownerId: string, id: string, input: UpdateProjectRequest): Promise<ProjectRow>;
  delete(ownerId: string, id: string): Promise<void>;
};

const missing = (id: string): NotFoundError =>
  new NotFoundError('Project not found', `No project with id ${id}.`);

export const createProjectService = (projects: ProjectRepository): ProjectService => ({
  create: (ownerId, input) => projects.create(ownerId, input.name),

  rename: async (ownerId, id, input) => {
    const renamed = await projects.rename(ownerId, id, input.name);
    if (!renamed) throw missing(id);
    return renamed;
  },

  delete: async (ownerId, id) => {
    const outcome = await projects.delete(ownerId, id);
    if (outcome.kind === 'missing') throw missing(id);
    if (outcome.kind === 'in-use') {
      const project = await projects.findById(ownerId, id);
      throw new ProjectInUseError(project?.name ?? 'this project', outcome.transactionCount);
    }
  },
});
