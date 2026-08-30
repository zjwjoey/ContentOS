import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssetCatalogService } from '../../../packages/modules/asset/src/index.js';
import type { ApprovalService } from '../../../packages/modules/approval/src/index.js';
import type { DirectorV1Service } from '../../../packages/modules/director/src/index.js';
import type { DirectorVideoService, VideoProjectReadService, VideoAdjustmentService, StandaloneQuickEditService, VideoService, QuickEditOperation } from '../../../packages/modules/video/src/index.js';
import type { JobRecord, JobService } from '../../../packages/modules/job/src/index.js';
import type { ProjectService } from '../../../packages/modules/project/src/index.js';
import type { AssetImportKind, AssetSummaryV0 } from '../../../packages/contracts/src/index.js';
import type { AssetImportService } from '../../../packages/modules/asset/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';

const videoJobInput = z.object({
  targetDurationMs: z.number().int().positive().optional(),
  voiceAssetId: z.string().trim().min(1).optional(),
  subtitleText: z.string().max(20_000).optional(),
  seed: z.number().int().optional(),
  videoAssetIds: z.array(z.string().trim().min(1)).min(1).max(64),
});
const legacyVideoJobInput = videoJobInput.partial();
const quickEditInput = z.object({ parentManifestId: z.string().trim().min(1), operations: z.array(z.record(z.string(), z.unknown())).max(128), createdBy: z.string().trim().min(1).max(200), idempotencyKey: z.string().trim().min(1).max(200).optional() });
const standaloneCreateInput = z.object({ sourceAssetIds: z.array(z.string().trim().min(1)).max(128).default([]), voiceAssetId: z.string().trim().min(1).optional(), seed: z.number().int().optional(), targetDurationMs: z.number().int().positive().optional(), minClipDurationMs: z.number().int().positive().optional(), maxClipDurationMs: z.number().int().positive().optional() });
const standaloneAdjustmentInput = z.object({ operations: z.array(z.record(z.string(), z.unknown())).min(1).max(128), createdBy: z.string().trim().min(1).max(200).optional() });

export interface VideoRouteDependencies {
  projects: ProjectService;
  director: DirectorV1Service;
  videoFromDirector: DirectorVideoService;
  videoRead: VideoProjectReadService;
  assets: AssetCatalogService;
  approvals: ApprovalService;
  jobs: JobService;
  video: VideoService;
  quickEdit: VideoAdjustmentService;
  standaloneQuickEdit: StandaloneQuickEditService;
  assetImports: AssetImportService;
  storage: LocalStorageProvider;
  maxUploadBytes: number;
}

function projectIdOf(request: { params: unknown }): string { return (request.params as { projectId: string }).projectId; }
function safeAsset(asset: AssetSummaryV0): AssetSummaryV0 { return asset; }
function videoOptions(input: z.infer<typeof videoJobInput>): { videoAssetIds: string[]; targetDurationMs?: number; voiceAssetId?: string; subtitleText?: string; seed?: number } {
  return {
    videoAssetIds: input.videoAssetIds,
    ...(input.targetDurationMs !== undefined ? { targetDurationMs: input.targetDurationMs } : {}),
    ...(input.voiceAssetId !== undefined ? { voiceAssetId: input.voiceAssetId } : {}),
    ...(input.subtitleText !== undefined ? { subtitleText: input.subtitleText } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
}
function legacyVideoOptions(input: z.infer<typeof legacyVideoJobInput>): { videoAssetIds?: string[]; targetDurationMs?: number; voiceAssetId?: string; subtitleText?: string; seed?: number } {
  return {
    ...(input.videoAssetIds !== undefined ? { videoAssetIds: input.videoAssetIds } : {}),
    ...(input.targetDurationMs !== undefined ? { targetDurationMs: input.targetDurationMs } : {}),
    ...(input.voiceAssetId !== undefined ? { voiceAssetId: input.voiceAssetId } : {}),
    ...(input.subtitleText !== undefined ? { subtitleText: input.subtitleText } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
}
function safeManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const timeline = Array.isArray(manifest.timeline) ? manifest.timeline.map((clip) => {
    if (!clip || typeof clip !== 'object') return clip;
    const { sourcePath: _sourcePath, ...safeClip } = clip as Record<string, unknown>;
    return safeClip;
  }) : [];
  const audio = manifest.audio && typeof manifest.audio === 'object' ? (() => { const { voicePath: _voicePath, ...safeAudio } = manifest.audio as Record<string, unknown>; return safeAudio; })() : manifest.audio;
  return { ...manifest, timeline, audio };
}
function safeManifestRecord(record: Awaited<ReturnType<VideoAdjustmentService['getManifest']>>): unknown {
  if (!record) return null;
  return { ...record, manifest: safeManifest(record.manifest as unknown as Record<string, unknown>) };
}
function safeJob(job: JobRecord): Record<string, unknown> {
  return { id: job.id, projectId: job.projectId, workspaceId: job.workspaceId, type: job.type, state: job.state, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts };
}

export function registerVideoRoutes(app: FastifyInstance, dependencies: VideoRouteDependencies): void {
  const { projects, director, videoFromDirector, videoRead, assets, approvals, jobs, video, quickEdit, standaloneQuickEdit } = dependencies;

  app.post('/api/v1/video/quick-edits', async (request, reply) => {
    const parsed = standaloneCreateInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Standalone Quick Edit input', details: parsed.error.issues } });
    try { return reply.code(201).send(await standaloneQuickEdit.create({ sourceAssetIds: parsed.data.sourceAssetIds, ...(parsed.data.voiceAssetId ? { voiceAssetId: parsed.data.voiceAssetId } : {}), ...(parsed.data.seed !== undefined ? { seed: parsed.data.seed } : {}), ...(parsed.data.targetDurationMs !== undefined ? { targetDurationMs: parsed.data.targetDurationMs } : {}), ...(parsed.data.minClipDurationMs !== undefined ? { minClipDurationMs: parsed.data.minClipDurationMs } : {}), ...(parsed.data.maxClipDurationMs !== undefined ? { maxClipDurationMs: parsed.data.maxClipDurationMs } : {}) })); }
    catch (error) { return reply.code(422).send({ error: { code: 'STANDALONE_QUICK_EDIT_INVALID', message: error instanceof Error ? error.message : 'Standalone Quick Edit rejected', details: [] } }); }
  });
  app.get('/api/v1/video/quick-edits/:id', async (request, reply) => {
    const session = await standaloneQuickEdit.get((request.params as { id: string }).id);
    return session ? session : reply.code(404).send({ error: { code: 'STANDALONE_QUICK_EDIT_NOT_FOUND', message: 'Standalone Quick Edit not found', details: [] } });
  });
  app.post('/api/v1/video/quick-edits/:id/plan', async (request, reply) => {
    try { return reply.code(201).send(safeManifestRecord(await standaloneQuickEdit.plan((request.params as { id: string }).id))); }
    catch (error) { return reply.code(422).send({ error: { code: 'STANDALONE_PLAN_INVALID', message: error instanceof Error ? error.message : 'Standalone plan rejected', details: [] } }); }
  });
  app.get('/api/v1/video/quick-edits/:id/manifests', async (request, reply) => {
    const session = await standaloneQuickEdit.get((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: { code: 'STANDALONE_QUICK_EDIT_NOT_FOUND', message: 'Standalone Quick Edit not found', details: [] } });
    return { items: (await quickEdit.listManifests('', session.workspaceId)).map((record) => safeManifestRecord(record)) };
  });
  app.post('/api/v1/video/quick-edits/:id/adjustments', async (request, reply) => {
    const parsed = standaloneAdjustmentInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Standalone Adjustment input', details: parsed.error.issues } });
    try { return reply.code(201).send(safeManifestRecord(await standaloneQuickEdit.adjust((request.params as { id: string }).id, parsed.data.operations as QuickEditOperation[], parsed.data.createdBy || 'operator'))); }
    catch (error) { return reply.code(409).send({ error: { code: 'STANDALONE_ADJUSTMENT_CONFLICT', message: error instanceof Error ? error.message : 'Standalone adjustment rejected', details: [] } }); }
  });
  app.post('/api/v1/video/quick-edits/:id/render', async (request, reply) => {
    try { return reply.code(201).send(safeJob(await standaloneQuickEdit.render((request.params as { id: string }).id))); }
    catch (error) { return reply.code(409).send({ error: { code: 'STANDALONE_RENDER_CONFLICT', message: error instanceof Error ? error.message : 'Standalone render rejected', details: [] } }); }
  });
  app.post('/api/v1/video/quick-edits/:id/assets', async (request, reply) => {
    const session = await standaloneQuickEdit.get((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: { code: 'STANDALONE_QUICK_EDIT_NOT_FOUND', message: 'Standalone Quick Edit not found', details: [] } });
    const part = await request.file();
    if (!part) return reply.code(422).send({ error: { code: 'UPLOAD_REQUIRED', message: 'An asset file is required', details: [] } });
    const kind: AssetImportKind | null = part.mimetype.startsWith('video/') ? 'VIDEO' : part.mimetype.startsWith('audio/') ? 'AUDIO' : null;
    if (!kind) { await part.file.resume(); return reply.code(422).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Only video and audio uploads are supported', details: [] } }); }
    let staged: Awaited<ReturnType<LocalStorageProvider['stageUpload']>> | undefined;
    let importId: string | undefined;
    let jobId: string | undefined;
    try {
      staged = await dependencies.storage.stageUpload(part.filename, part.file, dependencies.maxUploadBytes);
      if ((part.file as typeof part.file & { truncated?: boolean }).truncated) throw new Error('UPLOAD_TOO_LARGE');
      const record = await dependencies.assetImports.createStaged({ workspaceId: session.workspaceId, originalName: staged.originalName, kind, byteSize: staged.byteSize, stagedPath: staged.stagedPath, correlationId: randomUUID() });
      importId = record.id;
      const job = await jobs.createIdempotent({ id: `job-${randomUUID()}`, type: 'ASSET_IMPORT', projectId: null, workspaceId: session.workspaceId, payload: { schemaVersion: 'ASSET_IMPORT_V0', workspaceId: session.workspaceId, importId: record.id, correlationId: record.correlationId }, idempotencyKey: `asset-import:${record.id}`, maxAttempts: 3 });
      jobId = job.id;
      await dependencies.assetImports.attachWorkspaceJob(session.workspaceId, record.id, job.id);
      return reply.code(202).send({ import: await dependencies.assetImports.getWorkspace(session.workspaceId, record.id), jobId: job.id });
    } catch (cause) {
      if (importId) { try { await dependencies.assetImports.failWorkspace(session.workspaceId, importId, { code: cause instanceof Error ? cause.message.slice(0, 80) : 'ASSET_IMPORT_FAILED', message: 'Asset import could not be queued' }); } catch { /* preserve original failure */ } }
      if (jobId) { try { await jobs.requestCancel(jobId); } catch { /* preserve original failure */ } }
      if (staged) await dependencies.storage.removeStaged(staged.stagedPath);
      const message = cause instanceof Error && cause.message === 'UPLOAD_TOO_LARGE' ? 'Upload exceeds the configured size limit' : cause instanceof Error && cause.message === 'EMPTY_UPLOAD' ? 'Upload cannot be empty' : 'Asset upload failed';
      return reply.code(message === 'Asset upload failed' ? 422 : 413).send({ error: { code: message === 'Asset upload failed' ? 'ASSET_IMPORT_FAILED' : cause instanceof Error ? cause.message : 'ASSET_IMPORT_FAILED', message, details: [] } });
    }
  });
  app.get('/api/v1/video/quick-edits/:id/assets', async (request, reply) => {
    const session = await standaloneQuickEdit.get((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: { code: 'STANDALONE_QUICK_EDIT_NOT_FOUND', message: 'Standalone Quick Edit not found', details: [] } });
    return { items: await assets.listWorkspaceAssets(session.workspaceId), imports: await dependencies.assetImports.listWorkspace(session.workspaceId) };
  });
  app.get('/api/v1/video/quick-edits/:id/assets/:assetId/content', async (request, reply) => {
    const { id, assetId } = request.params as { id: string; assetId: string };
    const session = await standaloneQuickEdit.get(id);
    if (!session) return reply.code(404).send({ error: { code: 'STANDALONE_QUICK_EDIT_NOT_FOUND', message: 'Standalone Quick Edit not found', details: [] } });
    const asset = await assets.getReadyWorkspaceAssetContent(session.workspaceId, assetId);
    if (!asset) return reply.code(404).send({ error: { code: 'ASSET_NOT_FOUND', message: 'Ready workspace asset not found', details: [] } });
    reply.header('content-type', asset.metadata.format === 'wav' ? 'audio/wav' : asset.kind === 'AUDIO' ? 'audio/mpeg' : asset.kind === 'VIDEO_RENDER' ? 'video/mp4' : 'video/mp4');
    reply.header('content-length', asset.byteSize); reply.header('accept-ranges', 'bytes'); reply.header('etag', `"${asset.checksum}"`);
    return reply.send((await import('node:fs')).createReadStream(dependencies.storage.objectPath(asset.storageKey)));
  });
  app.post('/api/v1/video/quick-edits/:id/manifests/:manifestId/render', async (request, reply) => {
    const { id, manifestId } = request.params as { id: string; manifestId: string };
    const session = await standaloneQuickEdit.get(id);
    if (!session) return reply.code(404).send({ error: { code: 'STANDALONE_QUICK_EDIT_NOT_FOUND', message: 'Standalone Quick Edit not found', details: [] } });
    const manifest = await quickEdit.getManifest('', manifestId, session.workspaceId);
    if (!manifest) return reply.code(404).send({ error: { code: 'VIDEO_MANIFEST_NOT_FOUND', message: 'Video Manifest not found', details: [] } });
    try { return reply.code(201).send(safeJob(await video.createManifestRenderJobForWorkspace(session.workspaceId, manifestId))); }
    catch (error) { return reply.code(409).send({ error: { code: 'STANDALONE_RENDER_CONFLICT', message: error instanceof Error ? error.message : 'Standalone render rejected', details: [] } }); }
  });

  app.get('/api/v1/projects/:projectId/video', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const [pair, projectAssets, history, currentRender, job] = await Promise.all([
      director.getCurrentVideoInput(projectId),
      assets.listProjectAssets(projectId),
      videoRead.listRenderHistory(projectId),
      videoRead.getCurrentRender(projectId),
      videoRead.getLatestVideoJob(projectId),
    ]);
    const sourceAssets = projectAssets.filter((asset) => asset.lifecycle === 'READY' && asset.kind === 'VIDEO').map(safeAsset);
    const voiceAssets = projectAssets.filter((asset) => asset.lifecycle === 'READY' && asset.kind === 'AUDIO').map(safeAsset);
    const current = currentRender ? { ...currentRender, status: 'SUCCEEDED' } : null;
    const approval = currentRender ? await approvals.getCurrent(projectId, 'RENDER', currentRender.renderId, currentRender.outputAssetId) : null;
    return {
      schemaVersion: 'VIDEO_WORKSPACE_V0', projectId,
      director: { ...(pair?.brief ? { briefId: pair.brief.id } : {}), ...(pair?.script ? { scriptRevisionId: pair.script.id } : {}), ...(pair?.storyboard ? { storyboardRevisionId: pair.storyboard.id } : {}), ready: Boolean(pair?.script?.status === 'ACCEPTED' && pair?.storyboard?.status === 'APPROVED' && pair.storyboard.scriptRevisionId === pair.script.id) },
      sourceAssets, voiceAssets, currentRender: current,
      renderHistory: history.map(({ jobId: _jobId, ...item }) => item), job,
      approval: approval ? { targetType: approval.targetType, targetId: approval.targetId, targetRevisionId: approval.targetRevisionId, status: approval.status } : null,
    };
  });

  app.get('/api/v1/projects/:projectId/video/manifests', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    return { items: (await quickEdit.listManifests(projectId)).map((record) => safeManifestRecord(record)) };
  });

  app.get('/api/v1/projects/:projectId/video/manifests/:manifestId', async (request, reply) => {
    const { projectId, manifestId } = request.params as { projectId: string; manifestId: string };
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const record = await quickEdit.getManifest(projectId, manifestId);
    if (!record) return reply.code(404).send({ error: { code: 'VIDEO_MANIFEST_NOT_FOUND', message: 'Video Manifest not found', details: [] } });
    return safeManifestRecord(record);
  });

  const createProjectAdjustment = async (request: any, reply: any) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = quickEditInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Quick Edit input', details: parsed.error.issues } });
    try {
      const result = await quickEdit.createVersion({ projectId, parentManifestId: parsed.data.parentManifestId, operations: parsed.data.operations as QuickEditOperation[], createdBy: parsed.data.createdBy, ...(parsed.data.idempotencyKey ? { idempotencyKey: parsed.data.idempotencyKey } : {}) });
      return reply.code(201).send(safeManifestRecord(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Quick Edit rejected';
      const code = message.includes('NOT_FOUND') ? 404 : message.includes('IDEMPOTENCY') || message.includes('CURRENT') ? 409 : 422;
      return reply.code(code).send({ error: { code: message.split(':')[0] || 'VIDEO_QUICK_EDIT_INVALID', message, details: [] } });
    }
  };
  app.post('/api/v1/projects/:projectId/video/adjustments', createProjectAdjustment);
  app.post('/api/v1/projects/:projectId/video/quick-edits', async (request, reply) => { reply.header('deprecation', 'true'); return createProjectAdjustment(request, reply); });

  app.post('/api/v1/projects/:projectId/video/manifests/:manifestId/render', async (request, reply) => {
    const { projectId, manifestId } = request.params as { projectId: string; manifestId: string };
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const manifest = await quickEdit.getManifest(projectId, manifestId);
    if (!manifest) return reply.code(404).send({ error: { code: 'VIDEO_MANIFEST_NOT_FOUND', message: 'Video Manifest not found', details: [] } });
    try { return reply.code(201).send(safeJob(await video.createManifestRenderJob(projectId, manifestId))); }
    catch (error) { return reply.code(409).send({ error: { code: 'VIDEO_MANIFEST_RENDER_CONFLICT', message: error instanceof Error ? error.message : 'Manifest render conflict', details: [] } }); }
  });

  app.post('/api/v1/projects/:projectId/video/jobs', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = videoJobInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Video Job input', details: parsed.error.issues } });
    const selected = await assets.listReadySourceAssets(projectId, parsed.data.videoAssetIds, 'VIDEO');
    if (selected.length !== new Set(parsed.data.videoAssetIds).size) return reply.code(422).send({ error: { code: 'VIDEO_SOURCE_ASSET_INVALID', message: 'Every selected source video must be READY and owned by this project', details: [] } });
    if (parsed.data.voiceAssetId && !(await assets.getReadySourceAsset(projectId, parsed.data.voiceAssetId, 'AUDIO'))) return reply.code(422).send({ error: { code: 'VIDEO_VOICE_ASSET_INVALID', message: 'The selected voice asset must be READY and owned by this project', details: [] } });
    try {
      return reply.code(201).send(await videoFromDirector.createVideoJob(projectId, videoOptions(parsed.data)));
    } catch (error) {
      return reply.code(409).send({ error: { code: 'DIRECTOR_VIDEO_CONFLICT', message: error instanceof Error ? error.message : 'Director to Video conflict', details: [] } });
    }
  });

  app.post('/api/v1/projects/:projectId/video/jobs/:jobId/cancel', async (request, reply) => {
    const projectId = projectIdOf(request); const jobId = (request.params as { jobId: string }).jobId;
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const job = await jobs.get(jobId);
    if (!job || job.projectId !== projectId || job.type !== 'VIDEO_RENDER') return reply.code(404).send({ error: { code: 'VIDEO_JOB_NOT_FOUND', message: 'Video Job not found for this project', details: [] } });
    await jobs.requestCancel(jobId);
    return { id: jobId, state: (await jobs.get(jobId))?.state || 'CANCELLED' };
  });

  // Compatibility alias kept for existing Director callers while the product route is standardized.
  app.post('/api/v1/projects/:id/video-jobs/from-director', async (request, reply) => {
    const projectId = (request.params as { id: string }).id;
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = legacyVideoJobInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Video Job input', details: parsed.error.issues } });
    try {
      return reply.code(201).send(await videoFromDirector.createVideoJob(projectId, legacyVideoOptions(parsed.data)));
    } catch (error) {
      return reply.code(409).send({ error: { code: 'DIRECTOR_VIDEO_CONFLICT', message: error instanceof Error ? error.message : 'Director to Video conflict', details: [] } });
    }
  });
}
