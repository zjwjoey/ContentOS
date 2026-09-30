import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { MEDIA_ANALYSIS, type MediaIntelligenceService } from '../../../packages/modules/intelligence/src/index.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { ProjectService } from '../../../packages/modules/project/src/index.js';

const createAnalysisInput = z.object({
  assetId: z.string().trim().min(1),
  capabilities: z.array(z.enum(['TECHNICAL', 'SHOTS', 'KEYFRAMES', 'ASR', 'VISION', 'EMBEDDING'])).min(1).optional(),
  idempotencyKey: z.string().trim().min(1).max(300).optional(),
}).strict();
const searchInput = z.object({ q: z.string().max(2_000).default(''), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();

export function registerIntelligentEditingRoutes(app: FastifyInstance, dependencies: { projects: ProjectService; jobs: JobService; intelligence: MediaIntelligenceService }): void {
  app.post('/api/v1/projects/:projectId/intelligence/analyses', async (request, reply) => {
    const projectId = String((request.params as { projectId: string }).projectId);
    if (!(await dependencies.projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = createAnalysisInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid media analysis input', details: parsed.error.issues } });
    try {
      const run = await dependencies.intelligence.createRun({ projectId, assetId: parsed.data.assetId, ...(parsed.data.capabilities ? { capabilities: parsed.data.capabilities } : {}), ...(parsed.data.idempotencyKey ? { idempotencyKey: parsed.data.idempotencyKey } : {}) });
      if (run.status === 'QUEUED' && !run.jobId) {
        const job = await dependencies.jobs.createIdempotent({ id: `job-${randomUUID()}`, type: MEDIA_ANALYSIS, projectId, workspaceId: null, payload: { schemaVersion: 'MEDIA_ANALYSIS_JOB_V1', projectId, assetId: run.assetId, runId: run.id, correlationId: `media-analysis-${run.id}` }, idempotencyKey: `media-analysis-job:${run.id}`, maxAttempts: 3 });
        await dependencies.intelligence.attachJob(run.id, job.id);
        return reply.code(202).send({ runId: run.id, jobId: job.id, state: job.state });
      }
      return reply.code(202).send({ runId: run.id, jobId: run.jobId, state: run.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Media analysis rejected';
      return reply.code(message.includes('NOT_FOUND') ? 404 : 409).send({ error: { code: message, message, details: [] } });
    }
  });
  app.get('/api/v1/projects/:projectId/intelligence/analyses/:runId', async (request, reply) => {
    const params = request.params as { projectId: string; runId: string };
    try { return await dependencies.intelligence.results(params.projectId, params.runId); }
    catch (error) { const message = error instanceof Error ? error.message : 'Media analysis not found'; return reply.code(message.includes('NOT_FOUND') ? 404 : 422).send({ error: { code: message, message, details: [] } }); }
  });
  app.get('/api/v1/projects/:projectId/intelligence/search', async (request, reply) => {
    const params = request.params as { projectId: string };
    if (!(await dependencies.projects.get(params.projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = searchInput.safeParse(request.query || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid intelligence search query', details: parsed.error.issues } });
    return { items: await dependencies.intelligence.search(params.projectId, parsed.data.q, parsed.data.limit) };
  });
}
