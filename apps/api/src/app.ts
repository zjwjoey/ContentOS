import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import multipart from '@fastify/multipart';
import type { Pool } from 'pg';
import { ProjectService } from '../../../packages/modules/project/src/index.js';
import { AssetCatalogService, AssetImportService, AssetService, LocalMediaSourceService } from '../../../packages/modules/asset/src/index.js';
import { DirectorService, DirectorProjectReadService } from '../../../packages/modules/director/src/index.js';
import { DirectorVideoService, VideoProjectReadService, VideoAdjustmentService, StandaloneQuickEditService, VideoService, VideoEditPresetService, ScriptEditingV3Service } from '../../../packages/modules/video/src/index.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { ReviewAnalyticsService, ReviewService } from '../../../packages/modules/review/src/index.js';
import type { DirectorPlanV0 } from '../../../packages/contracts/src/index.js';
import { serializeError } from '../../../packages/shared/src/errors.js';
import { DirectorV1Service } from '../../../packages/modules/director/src/index.js';
import { DirectorJobService } from '../../../packages/modules/director/src/index.js';
import { FakePublisherSimulationService, PublisherService } from '../../../packages/modules/publisher/src/index.js';
import { registerDirectorV1Routes } from './director-routes.js';
import { registerPublisherRoutes } from './publisher-routes.js';
import { registerApprovalRoutes } from './approval-routes.js';
import { ApprovalService } from '../../../packages/modules/approval/src/index.js';
import { ProjectCenterService } from './project-center.js';
import { registerProjectCenterRoutes } from './project-center-routes.js';
import { registerDashboardRoutes } from './dashboard-routes.js';
import { registerAssetRoutes } from './asset-routes.js';
import { registerVideoRoutes } from './video-routes.js';
import { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { registerReviewAnalyticsRoutes } from './review-analytics-routes.js';
import { BenchmarkService } from '../../../packages/modules/benchmark/src/index.js';
import { registerBenchmarkRoutes } from './benchmark-routes.js';
import { readAIProviderConfig } from '../../../packages/modules/ai/src/index.js';
import { registerEditingWorkbenchRoutes } from './editing-workbench-routes.js';
import { registerMediaProviderRoutes } from './media-provider-routes.js';
import { registerScriptEditingV2Routes } from './script-editing-v2-routes.js';
import { registerScriptEditingV3Routes } from './script-editing-v3-routes.js';
import { registerQwenRoutes } from './qwen-routes.js';
import { createExternalVideoProvider } from '../../../packages/modules/video/src/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { probeMedia } from '../../../packages/infrastructure/ffmpeg/src/index.js';
import { LocalPathAccessService } from '../../../packages/modules/local-path/src/index.js';
import { UnsupportedNativePathPicker } from '../../../packages/modules/local-path/src/index.js';
import { WindowsNativePathPicker } from '../../../packages/modules/local-path/src/native-path-picker.js';
import { registerLocalPathRoutes } from './local-path-routes.js';
import { DigitalHumanService, createRuntimeDigitalHumanProviders, type RuntimeDigitalHumanProviders } from '../../../packages/modules/digital-human/src/index.js';
import { registerDigitalHumanRoutes } from './digital-human-routes.js';
import { ProductionRunService } from '../../../packages/modules/production-run/src/index.js';
import { registerProductionRunRoutes } from './production-run-routes.js';

const execFileAsync = promisify(execFile);

const projectInput = z.object({ name: z.string().trim().min(1).max(200), metadata: z.record(z.string(), z.unknown()).optional() });
const directorInput = z.object({ seed: z.number().int(), brief: z.object({ topic: z.string().trim().min(1), audience: z.string().trim().min(1), objective: z.string().trim().min(1), tone: z.string().trim().min(1) }), storyboard: z.array(z.object({ id: z.string().trim().min(1), title: z.string().trim().min(1), narration: z.string().trim().min(1), visualIntent: z.string().trim().min(1), durationMs: z.number().int().positive(), sourceAssetIds: z.array(z.string()) })).min(1), provenance: z.object({ author: z.string().trim().min(1), source: z.enum(['manual', 'ai-draft']), promptVersion: z.string().optional(), modelProfile: z.string().optional() }) });
const reviewInput = z.object({ targetType: z.enum(['RENDER', 'PUBLISH']), targetId: z.string().trim().min(1), status: z.enum(['PENDING', 'APPROVED', 'REJECTED']), reviewer: z.string().trim().min(1), reason: z.string().trim().optional(), evidence: z.record(z.string(), z.unknown()).optional() }).superRefine((value, context) => { if (value.status === 'REJECTED' && !value.reason) context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'reason is required for rejected decisions' }); });
const reviewActionInput = z.object({ reviewer: z.string().trim().min(1), reason: z.string().trim().optional() });
function directorPlan(projectId: string, input: z.infer<typeof directorInput>): DirectorPlanV0 {
  return { schemaVersion: 'DIRECTOR_PLAN_V0', projectId, seed: input.seed, brief: input.brief, storyboard: input.storyboard, provenance: { author: input.provenance.author, source: input.provenance.source, ...(input.provenance.promptVersion ? { promptVersion: input.provenance.promptVersion } : {}), ...(input.provenance.modelProfile ? { modelProfile: input.provenance.modelProfile } : {}) } };
}

export interface ApiRuntimeDependencies { db: Pool; storage?: LocalStorageProvider; uploadMaxBytes?: number; allowFakePublisherControls?: boolean; localPathAccess?: LocalPathAccessService; nativePathPicker?: import('../../../packages/modules/local-path/src/index.js').NativePathPicker; digitalHumanProviders?: RuntimeDigitalHumanProviders; }

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
  const directorRead = new DirectorProjectReadService(directorV1, director);
  const jobs = new JobService(db);
  const benchmark = new BenchmarkService(db, jobs);
  const assets = new AssetCatalogService(db);
  const digitalHuman = new DigitalHumanService(db, jobs, assets);
  const productionRuns = new ProductionRunService(db);
  const assetService = new AssetService(db, storage, (path) => probeMedia(path, process.env.FFPROBE_PATH || 'ffprobe'));
  const localPathAccess = runtime.localPathAccess || new LocalPathAccessService({ db });
  const nativePathPicker = runtime.nativePathPicker || (process.platform === 'win32' ? new WindowsNativePathPicker() : new UnsupportedNativePathPicker());
  const localMedia = new LocalMediaSourceService({ db, thumbnailRoot: `${storage.root}/thumbnails`, pathAccess: localPathAccess });
  const video = new VideoService(db, storage, jobs, assets, localPathAccess);
  const videoFromDirector = new DirectorVideoService(directorV1, video, director);
  const quickEdit = new VideoAdjustmentService(db, assets, localMedia);
  const standaloneQuickEdit = new StandaloneQuickEditService(db, assets, quickEdit, video);
  const presets = new VideoEditPresetService(db);
  registerAssetRoutes(app, { projects, imports: new AssetImportService(db), assets, jobs, storage, maxUploadBytes: uploadMaxBytes });
  const publisher = new PublisherService(db);
  const reviewAnalytics = new ReviewAnalyticsService(db, jobs, publisher);
  registerReviewAnalyticsRoutes(app, { projects, publisher, analytics: reviewAnalytics });
  registerBenchmarkRoutes(app, { projects, benchmark });
  const projectCenter = new ProjectCenterService({ projects, director: directorRead, assets, video: new VideoProjectReadService(db), jobs, approvals, publisher });
  registerProjectCenterRoutes(app, { center: projectCenter });
  registerDashboardRoutes(app, { projects, center: projectCenter });
  registerDirectorV1Routes(app, { director: directorV1, directorJobs: new DirectorJobService(jobs), jobs, projects });
  registerVideoRoutes(app, { projects, director: directorV1, videoFromDirector, videoRead: new VideoProjectReadService(db), assets, assetService, approvals, jobs, video, quickEdit, standaloneQuickEdit, assetImports: new AssetImportService(db), storage, maxUploadBytes: uploadMaxBytes, localMedia, localPathAccess, presets });
  registerLocalPathRoutes(app, { access: localPathAccess, picker: nativePathPicker });
  registerDigitalHumanRoutes(app, { digitalHuman, projects, jobs, providers: runtime.digitalHumanProviders || createRuntimeDigitalHumanProviders(), quickEdit, video, assets, assetService, storage, mediaStagingSecret: process.env.CONTENTOS_MEDIA_STAGING_SECRET });
  registerProductionRunRoutes(app, { db, projects, productionRuns, editing: new ScriptEditingV3Service(db), jobs, video, approvals, publisher, digitalHuman });
  registerEditingWorkbenchRoutes(app, { db, localMedia, localPathAccess, quickEdit, video, jobs, assets, assetService, storage, maxUploadBytes: uploadMaxBytes, presets });
  registerScriptEditingV2Routes(app, { db, jobs, localPathAccess, video, assets, presets, storage });
  registerScriptEditingV3Routes(app, { db, jobs, video, assets: assetService, localMedia, localPathAccess, storage });
  registerQwenRoutes(app);
  registerMediaProviderRoutes(app, createExternalVideoProvider(), db);
  registerPublisherRoutes(app, { projects, publisher, approvals, assets, jobs, allowFakePublisherControls: runtime.allowFakePublisherControls === true, ...(runtime.allowFakePublisherControls ? { fakeSimulations: new FakePublisherSimulationService(db) } : {}) });
  registerApprovalRoutes(app, { projects, approvals, video: new VideoProjectReadService(db), publisher, director: directorV1 });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/api/v1/runtime/status', async () => {
    let postgres: 'HEALTHY' | 'UNAVAILABLE' = 'HEALTHY';
    try { await db.query('select 1'); } catch { postgres = 'UNAVAILABLE'; }
    const publisherEnabled = process.env.PUBLISHER_REAL_ADAPTERS_ENABLED === '1' || process.env.PUBLISHER_REAL_ADAPTERS_ENABLED === 'true';
    let ffmpeg: 'HEALTHY' | 'UNAVAILABLE' = 'UNAVAILABLE';
    try { const binary = process.env.FFMPEG_PATH || 'ffmpeg'; const result = await execFileAsync(binary, ['-encoders'], { timeout: 5000 }); ffmpeg = `${result.stdout}\n${result.stderr}`.includes('libx264') ? 'HEALTHY' : 'UNAVAILABLE'; } catch { ffmpeg = 'UNAVAILABLE'; }
    let assetStorage: 'HEALTHY' | 'UNAVAILABLE' = 'UNAVAILABLE';
    try { await access(process.env.STORAGE_ROOT || 'storage'); assetStorage = 'HEALTHY'; } catch { assetStorage = 'UNAVAILABLE'; }
    return { ai: readAIProviderConfig(), publisher: { fakeEnabled: true, realAdaptersEnabled: publisherEnabled }, runtime: { postgres, ffmpeg, assetStorage, videoWorker: 'UNKNOWN', publisherWorker: 'UNKNOWN', reviewWorker: 'UNKNOWN', benchmarkWorker: 'UNKNOWN' } };
  });
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
  app.get('/api/v1/projects', async (request) => {
    const query = request.query as { q?: string; status?: string; plannedDateFrom?: string; plannedDateTo?: string; account?: string; platform?: string };
    return { items: await projects.list({ ...(query.q ? { query: query.q } : {}), ...(query.status ? { status: query.status } : {}), ...(query.plannedDateFrom ? { plannedDateFrom: query.plannedDateFrom } : {}), ...(query.plannedDateTo ? { plannedDateTo: query.plannedDateTo } : {}), ...(query.account ? { account: query.account } : {}), ...(query.platform ? { platform: query.platform } : {}) }) };
  });
  app.patch('/api/v1/projects/:id', async (request, reply) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(200).optional(), metadata: z.record(z.string(), z.unknown()).optional(), status: z.string().trim().min(1).max(50).optional() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid project update', details: parsed.error.issues } });
    try { const input = parsed.data; return await projects.update((request.params as { id: string }).id, { ...(input.name ? { name: input.name } : {}), ...(input.metadata ? { metadata: input.metadata } : {}), ...(input.status ? { status: input.status } : {}) }); } catch (error) { return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: error instanceof Error ? error.message : 'Project not found', details: [] } }); }
  });
  app.post('/api/v1/projects/:id/archive', async (request, reply) => { try { return await projects.archive((request.params as { id: string }).id); } catch (error) { return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: error instanceof Error ? error.message : 'Project not found', details: [] } }); } });
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
