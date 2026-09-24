import type { RequestHandler } from 'express';
import type { CreateProjectRequest, UpdateProjectRequest } from '@pfm/contracts';
import { ownerIdOf } from '../../shared/auth/current-user.js';
import { validated } from '../../shared/middleware/validate.js';
import { toProject } from './mapper.js';
import type { ProjectService } from './service.js';

type IdParam = { id: string };

export type ProjectController = {
  create: RequestHandler;
  rename: RequestHandler;
  remove: RequestHandler;
};

export const createProjectController = (projects: ProjectService): ProjectController => ({
  create: async (req, res) => {
    const input = validated<CreateProjectRequest>(req);
    res.status(201).json(toProject(await projects.create(ownerIdOf(req), input)));
  },

  rename: async (req, res) => {
    const { id } = validated<IdParam>(req, 'params');
    const input = validated<UpdateProjectRequest>(req);
    res.json(toProject(await projects.rename(ownerIdOf(req), id, input)));
  },

  remove: async (req, res) => {
    const { id } = validated<IdParam>(req, 'params');
    await projects.delete(ownerIdOf(req), id);
    res.status(204).send();
  },
});
