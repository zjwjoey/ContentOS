import type { FastifyInstance } from 'fastify';
import type { ProjectCenterService } from './project-center.js';

export interface ProjectCenterRouteDependencies {
  center: ProjectCenterService;
}

export function registerProjectCenterRoutes(app: FastifyInstance, dependencies: ProjectCenterRouteDependencies): void {
  app.get('/api/v1/projects/:projectId/center', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    const snapshot = await dependencies.center.get(projectId);
    if (!snapshot) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    return snapshot;
  });
}
