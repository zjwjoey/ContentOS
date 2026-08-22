import type { FastifyInstance } from 'fastify';
import type { ProjectCenterSnapshot } from '../../../packages/contracts/src/index.js';

export interface ProjectCenterRouteDependencies {
  center: { get(projectId: string): Promise<ProjectCenterSnapshot | null> };
}

export function registerProjectCenterRoutes(app: FastifyInstance, dependencies: ProjectCenterRouteDependencies): void {
  app.get('/api/v1/projects/:projectId/center', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    try {
      const snapshot = await dependencies.center.get(projectId);
      if (!snapshot) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
      return snapshot;
    } catch {
      return reply.code(500).send({ error: { code: 'PROJECT_CENTER_UNAVAILABLE', message: 'Project Center is temporarily unavailable', details: [] } });
    }
  });
}
