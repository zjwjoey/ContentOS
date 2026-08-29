import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import multipart from '@fastify/multipart';
import type { Pool } from 'pg';
import { ProjectService } from '../../../packages/modules/project/src/index.js';
import { AssetCatalogService, AssetImportService } from '../../../packages/modules/asset/src/index.js';
import { DirectorService, DirectorProjectReadService } from '../../../packages/modules/director/src/index.js';
import { DirectorVideoService, VideoProjectReadService, VideoService } from '../../../packages/modules/video/src/index.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { ReviewService } from '../../../packages/modules/review/src/index.js';
import type { DirectorPlanV0 } from '../../../packages/contracts/src/index.js';
import { serializeError } from '../../../packages/shared/src/errors.js';
import { DirectorV1Service } from '../../../packages/modules/director/src/index.js';
import { DirectorJobService } from '../../../packages/modules/director/src/index.js';
import { PublisherService } from '../../../packages/modules/publisher/src/index.js';
import { registerDirectorV1Routes } from './director-routes.js';
import { registerPublisherRoutes } from './publisher-routes.js';
import { registerApprovalRoutes } from './approval-routes.js';
import { ApprovalService } from '../../../packages/modules/approval/src/index.js';
import { ProjectCenterService } from './project-center.js';
import { registerProjectCenterRoutes } from './project-center-routes.js';
import { registerAssetRoutes } from './asset-routes.js';
import { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';

const projectInput = z.object({ name: z.string().trim().min(1).max(200), metadata: z.record(z.string(), z.unknown()).optional() });
const directorInput = z.object({ seed: z.number().int(), brief: z.object({ topic: z.string().trim().min(1), audience: z.string().trim().min(1), objective: z.string().trim().min(1), tone: z.string().trim().min(1) }), storyboard: z.array(z.object({ id: z.string().trim().min(1), title: z.string().trim().min(1), narration: z.string().trim().min(1), visualIntent: z.string().trim().min(1), durationMs: z.number().int().positive(), sourceAssetIds: z.array(z.string()) })).min(1), provenance: z.object({ author: z.string().trim().min(1), source: z.enum(['manual', 'ai-draft']), promptVersion: z.string().optional(), modelProfile: z.string().optional() }) });
const videoJobInput = z.object({ targetDurationMs: z.number().int().positive().optional(), voiceAssetId: z.string().optional(), subtitleText: z.string().optional(), seed: z.number().int().optional(), videoAssetIds: z.array(z.string().trim().min(1)).min(1).max(64).optional() });
const reviewInput = z.object({ targetType: z.enum(['RENDER', 'PUBLISH']), targetId: z.string().trim().min(1), status: z.enum(['PENDING', 'APPROVED', 'REJECTED']), reviewer: z.string().trim().min(1), reason: z.string().trim().optional(), evidence: z.record(z.string(), z.unknown()).optional() }).superRefine((value, context) => { if (value.status === 'REJECTED' && !value.reason) context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'reason is required for rejected decisions' }); });
const reviewActionInput = z.object({ reviewer: z.string().trim().min(1), reason: z.string().trim().optional() });
function directorPlan(projectId: string, input: z.infer<typeof directorInput>): DirectorPlanV0 {
  return { schemaVersion: 'DIRECTOR_PLAN_V0', projectId, seed: input.seed, brief: input.brief, storyboard: input.storyboard, provenance: { author: input.provenance.author, source: input.provenance.source, ...(input.provenance.promptVersion ? { promptVersion: input.provenance.promptVersion } : {}), ...(input.provenance.modelProfile ? { modelProfile: input.provenance.modelProfile } : {}) } };
}

export interface ApiRuntimeDependencies { db: Pool; storage?: LocalStorageProvider; uploadMaxBytes?: number; }

export async function buildApi(input: Pool | ApiRuntimeDependencies): Promise<FastifyInstance> {
  const db = 'query' in input ? input : input.db;
  const runtime: ApiRuntimeDependencies = 'query' in input ? { db } : input;
  const app = Fastify({ logger: false });
  const storage = runtime.storage || new LocalStorageProvider(process.env.STORAGE_ROOT || 'storage');
  const uploadMaxBytes = runtime.uploadMaxBytes || 500 * 1024 * 1024;
  await app.register(multipart, { limits: { files: 1, fileSize: uploadMaxBytes } });
  const projects = new ProjectService(db);
  const director = new DirectorService(db, projects);
  const reviews = new ReviewService(db, projects);
  const approvals = new ApprovalService(db, projects);
  const directorV1 = new DirectorV1Service(db);
  const videoFromDirector = new DirectorVideoService(directorV1, new VideoService(db, new JobService(db)), director);
  const directorRead = new DirectorProjectReadService(directorV1, director);
  const jobs = new JobService(db);
  const assets = new AssetCatalogService(db);
  registerAssetRoutes(app, { projects, imports: new AssetImportService(db), assets, jobs, storage, maxUploadBytes: uploadMaxBytes });
  const publisher = new PublisherService(db);
  registerProjectCenterRoutes(app, { center: new ProjectCenterService({ projects, director: directorRead, assets, video: new VideoProjectReadService(db), jobs, approvals, publisher }) });
  registerDirectorV1Routes(app, { director: directorV1, directorJobs: new DirectorJobService(jobs), jobs, projects });
  registerPublisherRoutes(app, { projects, publisher, approvals, assets, jobs });
  registerApprovalRoutes(app, { projects, approvals });
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
    const options = { ...(parsed.data.targetDurationMs ? { targetDurationMs: parsed.data.targetDurationMs } : {}), ...(parsed.data.voiceAssetId ? { voiceAssetId: parsed.data.voiceAssetId } : {}), ...(parsed.data.subtitleText ? { subtitleText: parsed.data.subtitleText } : {}), ...(parsed.data.seed !== undefined ? { seed: parsed.data.seed } : {}), ...(parsed.data.videoAssetIds ? { videoAssetIds: parsed.data.videoAssetIds } : {}) };
    try { return reply.code(201).send(await videoFromDirector.createVideoJob(projectId, options)); }
    catch (error) { return reply.code(409).send({ error: { code: 'DIRECTOR_VIDEO_CONFLICT', message: error instanceof Error ? error.message : 'Director to Video conflict', details: [] } }); }
  });
  app.post('/api/v1/projects/:id/reviews', async (request, reply) => {
    const projectId = (request.params as { id: string }).id;
    const parsed = reviewInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid review decision', details: parsed.error.issues } });
    return reply.code(410).send({ error: { code: 'REVIEW_LEGACY_READ_ONLY', message: 'Pre-publish decisions must use the Approval Gate', details: [] } });
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
    return reply.code(410).send({ error: { code: 'REVIEW_LEGACY_READ_ONLY', message: 'Pre-publish decisions must use the Approval Gate', details: [] } });
  });
  app.post('/api/v1/projects/:id/reviews/:targetType/:targetId/reject', async (request, reply) => {
    const params = request.params as { id: string; targetType: string; targetId: string };
    const targetType = z.enum(['RENDER', 'PUBLISH']).safeParse(params.targetType);
    const parsed = reviewActionInput.safeParse(request.body);
    if (!targetType.success || !parsed.success || !parsed.data.reason) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'A rejection reason is required', details: [...(targetType.success ? [] : targetType.error.issues), ...(parsed.success ? [] : parsed.error.issues)] } });
    return reply.code(410).send({ error: { code: 'REVIEW_LEGACY_READ_ONLY', message: 'Pre-publish decisions must use the Approval Gate', details: [] } });
  });
  app.setErrorHandler((error, _request, reply) => reply.code(500).send({ error: serializeError(error, 'InfrastructureError', 'api') }));
  return app;
}
