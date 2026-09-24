import { Router } from 'express';
import {
  CreateProjectRequest,
  ProjectIdParam,
  UpdateProjectRequest,
  routes,
} from '@pfm/contracts';
import { validate } from '../../shared/middleware/validate.js';
import type { ProjectController } from './controller.js';

// `GET /projects` and the project report are reporting queries, mounted with
// the reporting module.
export const projectRoutes = (projects: ProjectController): Router => {
  const router = Router();
  const item = `${routes.projects}/:id`;

  router.post(routes.projects, validate(CreateProjectRequest), projects.create);
  router.patch(
    item,
    validate(ProjectIdParam, 'params'),
    validate(UpdateProjectRequest),
    projects.rename,
  );
  router.delete(item, validate(ProjectIdParam, 'params'), projects.remove);

  return router;
};
