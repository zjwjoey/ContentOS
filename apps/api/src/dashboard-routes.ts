import type { FastifyInstance } from 'fastify';
import type { ProjectCenterSnapshot } from '../../../packages/contracts/src/index.js';
import type { ProjectService } from '../../../packages/modules/project/src/index.js';

export interface DashboardRouteDependencies {
  projects: ProjectService;
  center: { get(projectId: string): Promise<ProjectCenterSnapshot | null> };
}

/** Product-level dashboard assembled from public module services. */
export function registerDashboardRoutes(app: FastifyInstance, dependencies: DashboardRouteDependencies): void {
  app.get('/api/v1/dashboard', async (_request, reply) => {
    try {
      const projects = await dependencies.projects.list();
      const snapshots = await Promise.all(projects.map((project) => dependencies.center.get(project.id)));
      const items = snapshots.filter((snapshot): snapshot is ProjectCenterSnapshot => Boolean(snapshot));
      const counts = { total: projects.length, active: 0, attention: 0, blocked: 0, complete: 0, pendingActions: 0, runningJobs: 0 };
      for (const item of items) {
        if (item.project.status !== 'ARCHIVED') counts.active += 1;
        if (item.health.level === 'ATTENTION') counts.attention += 1;
        if (item.health.level === 'BLOCKED') counts.blocked += 1;
        if (item.health.level === 'COMPLETE') counts.complete += 1;
        counts.pendingActions += item.actions.filter((action) => action.severity !== 'INFO').length;
        counts.runningJobs += item.recentJobs.filter((job) => ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.state)).length;
      }
      const actionable = items.flatMap((item) => item.actions.filter((action) => action.severity !== 'INFO').map((action) => ({ projectId: item.project.id, projectName: item.project.name, ...action })));
      return { counts, actions: actionable, recentProjects: items.slice(0, 8).map((item) => ({ project: item.project, health: item.health, currentStage: item.currentStage, actions: item.actions.filter((action) => action.severity !== 'INFO').slice(0, 3), recentJobs: item.recentJobs.slice(0, 3) })) };
    } catch (error) {
      return reply.code(503).send({ error: { code: 'DASHBOARD_UNAVAILABLE', message: error instanceof Error ? error.message : 'Dashboard is temporarily unavailable', details: [] } });
    }
  });
}
