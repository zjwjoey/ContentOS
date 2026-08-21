import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { ProjectService } from '../../../packages/modules/project/src/index.js';
import { DirectorService } from '../../../packages/modules/director/src/index.js';
import { DirectorVideoService, VideoService } from '../../../packages/modules/video/src/index.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { ReviewService } from '../../../packages/modules/review/src/index.js';
import type { DirectorPlanV0 } from '../../../packages/contracts/src/index.js';
import { serializeError } from '../../../packages/shared/src/errors.js';

const projectInput = z.object({ name: z.string().trim().min(1).max(200), metadata: z.record(z.string(), z.unknown()).optional() });
const directorInput = z.object({ seed: z.number().int(), brief: z.object({ topic: z.string().trim().min(1), audience: z.string().trim().min(1), objective: z.string().trim().min(1), tone: z.string().trim().min(1) }), storyboard: z.array(z.object({ id: z.string().trim().min(1), title: z.string().trim().min(1), narration: z.string().trim().min(1), visualIntent: z.string().trim().min(1), durationMs: z.number().int().positive(), sourceAssetIds: z.array(z.string()) })).min(1), provenance: z.object({ author: z.string().trim().min(1), source: z.enum(['manual', 'ai-draft']), promptVersion: z.string().optional(), modelProfile: z.string().optional() }) });
const videoJobInput = z.object({ targetDurationMs: z.number().int().positive().optional(), voiceAssetId: z.string().optional(), subtitleText: z.string().optional(), seed: z.number().int().optional() });
const reviewInput = z.object({ targetType: z.enum(['RENDER', 'PUBLISH']), targetId: z.string().trim().min(1), status: z.enum(['PENDING', 'APPROVED', 'REJECTED']), reviewer: z.string().trim().min(1), reason: z.string().trim().optional(), evidence: z.record(z.string(), z.unknown()).optional() }).superRefine((value, context) => { if (value.status === 'REJECTED' && !value.reason) context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'reason is required for rejected decisions' }); });
const reviewActionInput = z.object({ reviewer: z.string().trim().min(1), reason: z.string().trim().optional() });
function directorPlan(projectId: string, input: z.infer<typeof directorInput>): DirectorPlanV0 {
  return { schemaVersion: 'DIRECTOR_PLAN_V0', projectId, seed: input.seed, brief: input.brief, storyboard: input.storyboard, provenance: { author: input.provenance.author, source: input.provenance.source, ...(input.provenance.promptVersion ? { promptVersion: input.provenance.promptVersion } : {}), ...(input.provenance.modelProfile ? { modelProfile: input.provenance.modelProfile } : {}) } };
}

export async function buildApi(db: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const projects = new ProjectService(db);
  const director = new DirectorService(db, projects);
  const videoFromDirector = new DirectorVideoService(director, new VideoService(db, new JobService(db)));
  const reviews = new ReviewService(db, projects);
  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/api/v1/projects', async (request, reply) => {
    const parsed = projectInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid project input', details: parsed.error.issues } });
    const result = await projects.create(parsed.data.name, parsed.data.metadata || {});
    return reply.code(201).send(result);
  });
  app.get('/api/v1/projects/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const result = await projects.get(id);
    if (!result) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    return result;
  });
  app.get('/api/v1/projects', async () => ({ items: await projects.list() }));
  app.get('/api/v1/projects/:id/assets', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const project = await projects.get(id);
    if (!project) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const assets = await db.query('select a.* from assets a join project_assets pa on pa.asset_id = a.id where pa.project_id = $1 order by a.created_at', [id]);
    return { items: assets.rows };
  });
  app.post('/api/v1/projects/:id/director-plans', async (request, reply) => {
    const projectId = (request.params as { id: string }).id;
    const parsed = directorInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Director plan', details: parsed.error.issues } });
    const plan = directorPlan(projectId, parsed.data);
    try { return reply.code(201).send(await director.createDraft(projectId, plan)); }
    catch (error) { return reply.code(404).send({ error: { code: 'DIRECTOR_PROJECT_NOT_FOUND', message: error instanceof Error ? error.message : 'Project not found', details: [] } }); }
  });
  app.get('/api/v1/projects/:id/director-plans/current', async (request, reply) => {
    const projectId = (request.params as { id: string }).id;
    const current = await director.getCurrent(projectId);
    if (!current) return reply.code(404).send({ error: { code: 'DIRECTOR_PLAN_NOT_FOUND', message: 'No approved Director plan', details: [] } });
    return current;
  });
  app.post('/api/v1/projects/:id/director-plans/:revision/revise', async (request, reply) => {
    const params = request.params as { id: string; revision: string };
    const parsed = directorInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Director plan', details: parsed.error.issues } });
    const plan = directorPlan(params.id, parsed.data);
    try { return reply.code(201).send(await director.revise(params.id, Number(params.revision), plan)); }
    catch (error) { return reply.code(409).send({ error: { code: 'DIRECTOR_REVISION_CONFLICT', message: error instanceof Error ? error.message : 'Revision conflict', details: [] } }); }
  });
  app.post('/api/v1/projects/:id/director-plans/:revision/accept', async (request, reply) => {
    const params = request.params as { id: string; revision: string };
    try { return await director.accept(params.id, Number(params.revision)); }
    catch (error) { return reply.code(409).send({ error: { code: 'DIRECTOR_REVISION_CONFLICT', message: error instanceof Error ? error.message : 'Revision conflict', details: [] } }); }
  });
  app.post('/api/v1/projects/:id/director-plans/:revision/approve', async (request, reply) => {
    const params = request.params as { id: string; revision: string };
    try { return await director.approveStoryboard(params.id, Number(params.revision)); }
    catch (error) { return reply.code(409).send({ error: { code: 'DIRECTOR_REVISION_CONFLICT', message: error instanceof Error ? error.message : 'Revision conflict', details: [] } }); }
  });
  app.post('/api/v1/projects/:id/video-jobs/from-director', async (request, reply) => {
    const projectId = (request.params as { id: string }).id;
    const parsed = videoJobInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Video Job input', details: parsed.error.issues } });
    const options = { ...(parsed.data.targetDurationMs ? { targetDurationMs: parsed.data.targetDurationMs } : {}), ...(parsed.data.voiceAssetId ? { voiceAssetId: parsed.data.voiceAssetId } : {}), ...(parsed.data.subtitleText ? { subtitleText: parsed.data.subtitleText } : {}), ...(parsed.data.seed !== undefined ? { seed: parsed.data.seed } : {}) };
    try { return reply.code(201).send(await videoFromDirector.createVideoJob(projectId, options)); }
    catch (error) { return reply.code(409).send({ error: { code: 'DIRECTOR_VIDEO_CONFLICT', message: error instanceof Error ? error.message : 'Director to Video conflict', details: [] } }); }
  });
  app.post('/api/v1/projects/:id/reviews', async (request, reply) => {
    const projectId = (request.params as { id: string }).id;
    const parsed = reviewInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid review decision', details: parsed.error.issues } });
    try { return reply.code(201).send(await reviews.create({ projectId, ...parsed.data })); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Review decision rejected';
      return reply.code(message.includes('not found') ? 404 : 422).send({ error: { code: 'REVIEW_VALIDATION_ERROR', message, details: [] } });
    }
  });
  app.get('/api/v1/projects/:id/reviews/:targetType/:targetId/current', async (request, reply) => {
    const params = request.params as { id: string; targetType: string; targetId: string };
    const targetType = z.enum(['RENDER', 'PUBLISH']).safeParse(params.targetType);
    if (!targetType.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid review target type', details: targetType.error.issues } });
    const current = await reviews.getCurrent(params.id, targetType.data, params.targetId);
    if (!current) return reply.code(404).send({ error: { code: 'REVIEW_NOT_FOUND', message: 'Review decision not found', details: [] } });
    return current;
  });
  app.post('/api/v1/projects/:id/reviews/:targetType/:targetId/approve', async (request, reply) => {
    const params = request.params as { id: string; targetType: string; targetId: string };
    const targetType = z.enum(['RENDER', 'PUBLISH']).safeParse(params.targetType);
    const parsed = reviewActionInput.safeParse(request.body);
    if (!targetType.success || !parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid review approval', details: [...(targetType.success ? [] : targetType.error.issues), ...(parsed.success ? [] : parsed.error.issues)] } });
    try { return await reviews.approve(params.id, targetType.data, params.targetId, parsed.data.reviewer); }
    catch (error) { return reply.code(409).send({ error: { code: 'REVIEW_TRANSITION_CONFLICT', message: error instanceof Error ? error.message : 'Review transition conflict', details: [] } }); }
  });
  app.post('/api/v1/projects/:id/reviews/:targetType/:targetId/reject', async (request, reply) => {
    const params = request.params as { id: string; targetType: string; targetId: string };
    const targetType = z.enum(['RENDER', 'PUBLISH']).safeParse(params.targetType);
    const parsed = reviewActionInput.safeParse(request.body);
    if (!targetType.success || !parsed.success || !parsed.data.reason) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'A rejection reason is required', details: [...(targetType.success ? [] : targetType.error.issues), ...(parsed.success ? [] : parsed.error.issues)] } });
    try { return await reviews.reject(params.id, targetType.data, params.targetId, parsed.data.reviewer, parsed.data.reason); }
    catch (error) { return reply.code(409).send({ error: { code: 'REVIEW_TRANSITION_CONFLICT', message: error instanceof Error ? error.message : 'Review transition conflict', details: [] } }); }
  });
  app.setErrorHandler((error, _request, reply) => reply.code(500).send({ error: serializeError(error, 'InfrastructureError', 'api') }));
  return app;
}
