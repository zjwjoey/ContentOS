import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ReviewAnalyticsService } from '../../../packages/modules/review/src/index.js';
import type { PublisherService } from '../../../packages/modules/publisher/src/index.js';
import type { ProjectService } from '../../../packages/modules/project/src/index.js';

const collectInput = z.object({ source: z.enum(['FAKE', 'IMPORT']).default('FAKE'), idempotencyKey: z.string().trim().min(1).max(200), correlationId: z.string().trim().min(1).max(200) });
const analyzeInput = z.object({ metricSnapshotIds: z.array(z.string().trim().min(1)).min(1).max(100), idempotencyKey: z.string().trim().min(1).max(200), correlationId: z.string().trim().min(1).max(200) });
const manualSnapshotInput = z.object({ capturedAt: z.string().datetime(), metrics: z.object({ plays: z.number().int().nonnegative(), likes: z.number().int().nonnegative(), comments: z.number().int().nonnegative(), saves: z.number().int().nonnegative(), shares: z.number().int().nonnegative(), followersDelta: z.number().int().optional(), completionRate: z.number().min(0).max(1).optional(), averageWatchTimeSeconds: z.number().nonnegative().optional() }), sourceReference: z.string().trim().min(1).max(500) }).strict();

function errorResponse(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, status: number, code: string, message: string): unknown {
  return reply.code(status).send({ error: { code, message, details: [] } });
}

export interface ReviewAnalyticsRouteDependencies {
  projects: ProjectService;
  publisher: PublisherService;
  analytics: ReviewAnalyticsService;
}

export function registerReviewAnalyticsRoutes(app: FastifyInstance, dependencies: ReviewAnalyticsRouteDependencies): void {
  app.get('/api/v1/projects/:projectId/reviews/analytics', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await dependencies.projects.get(projectId))) return errorResponse(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    const posts = await dependencies.publisher.listProjectExternalPosts(projectId);
    const items = await Promise.all(posts.map(async (post) => ({ post, snapshots: await dependencies.analytics.listMetricSnapshots(projectId, post.id), reports: await dependencies.analytics.listAnalysisReports(projectId, post.id) })));
    return { projectId, items };
  });

  app.get('/api/v1/projects/:projectId/reviews/analytics/posts/:externalPostId/snapshots', async (request, reply) => {
    const params = request.params as { projectId: string; externalPostId: string };
    if (!(await dependencies.publisher.getExternalPost(params.projectId, params.externalPostId))) return errorResponse(reply, 404, 'EXTERNAL_POST_NOT_FOUND', 'ExternalPost not found');
    return { items: await dependencies.analytics.listMetricSnapshots(params.projectId, params.externalPostId) };
  });

  app.post('/api/v1/projects/:projectId/reviews/analytics/posts/:externalPostId/snapshots', async (request, reply) => {
    const params = request.params as { projectId: string; externalPostId: string };
    const parsed = manualSnapshotInput.safeParse(request.body);
    if (!parsed.success) return errorResponse(reply, 422, 'VALIDATION_ERROR', '指标快照信息不完整');
    const post = await dependencies.publisher.getExternalPost(params.projectId, params.externalPostId);
    if (!post) return errorResponse(reply, 404, 'EXTERNAL_POST_NOT_FOUND', 'ExternalPost not found');
    try { const metrics = parsed.data.metrics; return reply.code(201).send(await dependencies.analytics.recordMetricSnapshot({ projectId: params.projectId, externalPostId: params.externalPostId, platformId: post.platformId, capturedAt: parsed.data.capturedAt, publishedAt: null, metrics: { plays: metrics.plays, likes: metrics.likes, comments: metrics.comments, saves: metrics.saves, shares: metrics.shares, ...(metrics.followersDelta !== undefined ? { followersDelta: metrics.followersDelta } : {}), ...(metrics.completionRate !== undefined ? { completionRate: metrics.completionRate } : {}), ...(metrics.averageWatchTimeSeconds !== undefined ? { averageWatchTimeSeconds: metrics.averageWatchTimeSeconds } : {}) }, source: 'IMPORT', sourceReference: parsed.data.sourceReference })); }
    catch (error) { return errorResponse(reply, 422, 'SNAPSHOT_INVALID', error instanceof Error ? error.message : '指标快照无效'); }
  });

  app.post('/api/v1/projects/:projectId/reviews/analytics/posts/:externalPostId/collect', async (request, reply) => {
    const params = request.params as { projectId: string; externalPostId: string };
    const parsed = collectInput.safeParse(request.body);
    if (!parsed.success) return errorResponse(reply, 422, 'VALIDATION_ERROR', 'Invalid metric collection input');
    try {
      const job = await dependencies.analytics.createMetricCollectionJob({ projectId: params.projectId, externalPostId: params.externalPostId, ...parsed.data });
      return reply.code(201).send({ id: job.id, projectId: job.projectId, type: job.type, state: job.state });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Metric collection failed';
      return errorResponse(reply, /Idempotency key conflict/i.test(message) ? 409 : 404, /Idempotency key conflict/i.test(message) ? 'IDEMPOTENCY_CONFLICT' : 'EXTERNAL_POST_NOT_FOUND', message);
    }
  });

  app.post('/api/v1/projects/:projectId/reviews/analytics/posts/:externalPostId/analyze', async (request, reply) => {
    const params = request.params as { projectId: string; externalPostId: string };
    const parsed = analyzeInput.safeParse(request.body);
    if (!parsed.success) return errorResponse(reply, 422, 'VALIDATION_ERROR', 'Invalid analysis input');
    try {
      const job = await dependencies.analytics.createAnalysisJob({ projectId: params.projectId, externalPostId: params.externalPostId, ...parsed.data });
      return reply.code(201).send({ id: job.id, projectId: job.projectId, type: job.type, state: job.state });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Analysis failed';
      return errorResponse(reply, /Idempotency key conflict/i.test(message) ? 409 : /snapshot/i.test(message) ? 422 : 404, /Idempotency key conflict/i.test(message) ? 'IDEMPOTENCY_CONFLICT' : /snapshot/i.test(message) ? 'SNAPSHOT_INVALID' : 'EXTERNAL_POST_NOT_FOUND', message);
    }
  });

  app.get('/api/v1/projects/:projectId/reviews/analytics/posts/:externalPostId/reports', async (request, reply) => {
    const params = request.params as { projectId: string; externalPostId: string };
    if (!(await dependencies.publisher.getExternalPost(params.projectId, params.externalPostId))) return errorResponse(reply, 404, 'EXTERNAL_POST_NOT_FOUND', 'ExternalPost not found');
    return { items: await dependencies.analytics.listAnalysisReports(params.projectId, params.externalPostId) };
  });
}
