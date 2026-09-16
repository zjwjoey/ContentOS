import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LocalMediaSourceService } from '../../../packages/modules/asset/src/index.js';
import type { AssetCatalogService } from '../../../packages/modules/asset/src/index.js';
import type { ApprovalService } from '../../../packages/modules/approval/src/index.js';
import type { DirectorV1Service } from '../../../packages/modules/director/src/index.js';
import { assembleBrandedTimeline, buildRandomSentenceMontageManifest, buildScriptMontageManifest, segmentScriptSentences } from '../../../packages/modules/video/src/index.js';
import type { DirectorVideoService, VideoProjectReadService, VideoAdjustmentService, StandaloneQuickEditService, VideoService, QuickEditOperation, TimedScriptSentence } from '../../../packages/modules/video/src/index.js';
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
  plannerType: z.enum(['RANDOM', 'STORYBOARD']).optional(),
  videoAssetIds: z.array(z.string().trim().min(1)).min(1).max(64),
});
const legacyVideoJobInput = videoJobInput.partial();
const quickEditInput = z.object({ parentManifestId: z.string().trim().min(1), operations: z.array(z.record(z.string(), z.unknown())).max(128), createdBy: z.string().trim().min(1).max(200), idempotencyKey: z.string().trim().min(1).max(200).optional() });
const standaloneCreateInput = z.object({ sourceAssetIds: z.array(z.string().trim().min(1)).max(128).default([]), voiceAssetId: z.string().trim().min(1).optional(), seed: z.number().int().optional(), targetDurationMs: z.number().int().positive().optional(), minClipDurationMs: z.number().int().positive().optional(), maxClipDurationMs: z.number().int().positive().optional() });
const standaloneAdjustmentInput = z.object({ operations: z.array(z.record(z.string(), z.unknown())).min(1).max(128), createdBy: z.string().trim().min(1).max(200).optional() });
const standaloneVoiceInput = z.object({ assetId: z.string().trim().min(1) });
const standaloneSettingsInput = z.object({ seed: z.number().int().optional(), targetDurationMs: z.number().int().positive().nullable().optional(), minClipDurationMs: z.number().int().positive().optional(), maxClipDurationMs: z.number().int().positive().optional() });
const sentencePreviewInput = z.object({ script: z.string().max(100_000), splitSemicolon: z.boolean().optional() });
const localMediaScanInput = z.object({ projectId: z.string().trim().min(1).optional(), sourceRoot: z.string().trim().min(1), recursive: z.boolean().default(true), idempotencyKey: z.string().trim().min(1).max(200).optional() });
const localMediaContentInput = z.object({ projectId: z.string().trim().min(1).optional(), sourceRootId: z.string().trim().min(1), fileId: z.string().trim().min(1) });
const localMediaIndexQuery = z.object({ projectId: z.string().trim().min(1), query: z.string().max(200).optional(), orientation: z.enum(['ALL', 'VERTICAL', 'HORIZONTAL', 'SQUARE', 'UNKNOWN']).optional(), category: z.string().max(100).optional(), usage: z.enum(['ALL', 'UNUSED', 'RECENT', 'FREQUENT']).optional(), sort: z.enum(['NAME', 'UPDATED', 'DURATION', 'USAGE', 'RECENT']).optional() });
const localMediaMetaInput = z.object({ category: z.string().max(100).nullable().optional(), tags: z.array(z.string().max(80)).max(64).optional() });
const montagePlanInput = z.object({ mode: z.enum(['SCRIPT', 'RANDOM']), script: z.string().max(100_000).optional(), sentences: z.array(z.object({ index: z.number().int().nonnegative().optional(), text: z.string().trim().min(1), normalizedText: z.string().optional(), voiceStartMs: z.number().nonnegative().optional(), voiceEndMs: z.number().nonnegative().optional(), durationMs: z.number().positive().optional() })).optional(), videoAssetIds: z.array(z.string().trim().min(1)).max(256).default([]), sourceRoot: z.string().trim().min(1).optional(), scanId: z.string().trim().min(1).optional(), recursive: z.boolean().default(true), seed: z.number().int().default(1), minClipDurationMs: z.number().int().positive().default(2_000), maxClipDurationMs: z.number().int().positive().default(5_000), voiceAssetId: z.string().trim().min(1).optional(), introAssetId: z.string().trim().min(1).optional(), outroAssetId: z.string().trim().min(1).optional(), introDurationMs: z.number().int().positive().max(10_000).optional(), outroDurationMs: z.number().int().positive().max(10_000).optional() }).superRefine((value, context) => { if (!value.script?.trim() && !value.sentences?.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['script'], message: 'script or sentences is required' }); if (!value.sourceRoot && !value.scanId && value.videoAssetIds.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ['videoAssetIds'], message: 'videoAssetIds or sourceRoot/scanId is required' }); });

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
  localMedia?: LocalMediaSourceService;
}

function projectIdOf(request: { params: unknown }): string { return (request.params as { projectId: string }).projectId; }
function safeAsset(asset: AssetSummaryV0): AssetSummaryV0 { return asset; }
function videoOptions(input: z.infer<typeof videoJobInput>): { videoAssetIds: string[]; targetDurationMs?: number; voiceAssetId?: string; subtitleText?: string; seed?: number; plannerType?: 'RANDOM' | 'STORYBOARD' } {
  return {
    videoAssetIds: input.videoAssetIds,
    ...(input.targetDurationMs !== undefined ? { targetDurationMs: input.targetDurationMs } : {}),
    ...(input.voiceAssetId !== undefined ? { voiceAssetId: input.voiceAssetId } : {}),
    ...(input.subtitleText !== undefined ? { subtitleText: input.subtitleText } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.plannerType !== undefined ? { plannerType: input.plannerType } : {}),
  };
}
function legacyVideoOptions(input: z.infer<typeof legacyVideoJobInput>): { videoAssetIds?: string[]; targetDurationMs?: number; voiceAssetId?: string; subtitleText?: string; seed?: number; plannerType?: 'RANDOM' | 'STORYBOARD' } {
  return {
    ...(input.videoAssetIds !== undefined ? { videoAssetIds: input.videoAssetIds } : {}),
    ...(input.targetDurationMs !== undefined ? { targetDurationMs: input.targetDurationMs } : {}),
    ...(input.voiceAssetId !== undefined ? { voiceAssetId: input.voiceAssetId } : {}),
    ...(input.subtitleText !== undefined ? { subtitleText: input.subtitleText } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.plannerType !== undefined ? { plannerType: input.plannerType } : {}),
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
function mediaContentType(asset: { kind: string; metadata: { format?: string }; originalName: string }): string {
  const format = (asset.metadata.format || '').toLowerCase().split(',')[0] || asset.originalName.toLowerCase().split('.').pop() || '';
  const types: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac' };
  return types[format] || (asset.kind === 'AUDIO' ? 'audio/mpeg' : 'video/mp4');
}

export function registerVideoRoutes(app: FastifyInstance, dependencies: VideoRouteDependencies): void {
  const { projects, director, videoFromDirector, videoRead, assets, approvals, jobs, video, quickEdit, standaloneQuickEdit, storage } = dependencies;

  app.post('/api/v1/video/sentence-preview', async (request, reply) => {
    const parsed = sentencePreviewInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: '请输入脚本文案。', details: parsed.error.issues } });
    return { items: segmentScriptSentences(parsed.data.script, parsed.data.splitSemicolon === undefined ? {} : { splitSemicolon: parsed.data.splitSemicolon }) };
  });
  app.get('/api/v1/projects/:projectId/video/current-script', async (request, reply) => {
    const projectId = projectIdOf(request); const pair = await director.getCurrentPair(projectId); const script = pair.script;
    if (!script || script.status !== 'ACCEPTED') return reply.code(404).send({ error: { code: 'DIRECTOR_SCRIPT_NOT_AVAILABLE', message: '当前项目暂无可用脚本，请先到脚本与分镜完成脚本。', details: [] } });
    const body = [script.hook, script.body, script.cta].filter((value): value is string => Boolean(value?.trim())).join('\n\n');
    return { projectId, scriptRevisionId: script.id, revision: script.revision, title: script.title, body, status: script.status };
  });
  app.post('/api/v1/video/local-media/scan', async (request, reply) => {
    const parsed = localMediaScanInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: '请输入素材文件夹路径。', details: parsed.error.issues } });
    if (!dependencies.localMedia) return reply.code(403).send({ error: { code: 'LOCAL_MEDIA_ROOT_UNAUTHORIZED', message: '服务端尚未配置本地素材授权根目录。', details: [] } });
    try {
      if (parsed.data.projectId && !(await projects.get(parsed.data.projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: '项目不存在。', details: [] } });
      const authorized = dependencies.localMedia.authorizeRoot(parsed.data.sourceRoot);
      const key = parsed.data.idempotencyKey || `local-media-scan:${parsed.data.projectId || 'workspace'}:${authorized.sourceRootId}:${parsed.data.recursive}`;
      const existing = await jobs.getByIdempotencyKey(key);
      if (existing) return reply.code(202).send({ scanId: (existing.payload as { scanId?: string }).scanId, jobId: existing.id, state: existing.state, sourceRootId: authorized.sourceRootId, progress: existing.progress });
      const scanId = `scan-${randomUUID()}`;
      if (!parsed.data.projectId) return reply.code(422).send({ error: { code: 'LOCAL_MEDIA_SCAN_PROJECT_REQUIRED', message: '素材扫描需要绑定项目。', details: [] } });
      await video.ensureProjectWorkspace(parsed.data.projectId);
      await dependencies.localMedia.createScan({ id: scanId, projectId: parsed.data.projectId, sourceRoot: authorized.root, recursive: parsed.data.recursive, sourceRootId: authorized.sourceRootId });
      const job = await jobs.createIdempotent({ id: `job-${randomUUID()}`, type: 'LOCAL_MEDIA_SCAN', projectId: parsed.data.projectId, workspaceId: `workspace-project-${parsed.data.projectId}`, payload: { schemaVersion: 'LOCAL_MEDIA_SCAN_V1', projectId: parsed.data.projectId, scanId, sourceRoot: authorized.root, sourceRootId: authorized.sourceRootId, recursive: parsed.data.recursive }, idempotencyKey: key, maxAttempts: 3 });
      return reply.code(202).send({ scanId, jobId: job.id, state: job.state, sourceRootId: authorized.sourceRootId, progress: job.progress });
    } catch (error) { const message = error instanceof Error ? error.message : '本地素材扫描失败。'; return reply.code(message.includes('UNAUTHORIZED') ? 403 : message.includes('NOT_FOUND') ? 404 : 422).send({ error: { code: message, message: message === 'LOCAL_MEDIA_ROOT_UNAUTHORIZED' ? '该本地文件夹未被授权。' : '本地素材扫描失败，请检查路径和权限。', details: [] } }); }
  });
  app.get('/api/v1/video/local-media/scans/:scanId', async (request, reply) => {
    if (!dependencies.localMedia) return reply.code(403).send({ error: { code: 'LOCAL_MEDIA_ROOT_UNAUTHORIZED', message: '服务端尚未配置本地素材授权根目录。', details: [] } });
    const query = request.query as { projectId?: string }; const scan = await dependencies.localMedia.getScan((request.params as { scanId: string }).scanId, query.projectId);
    if (!scan) return reply.code(404).send({ error: { code: 'LOCAL_MEDIA_SCAN_NOT_FOUND', message: '素材扫描任务不存在。', details: [] } });
    return { id: scan.id, projectId: scan.projectId, sourceRootId: scan.sourceRootId, recursive: scan.recursive, status: scan.status, progress: scan.progress, error: scan.error, files: scan.files.map(LocalMediaSourceService.toPublicFile) };
  });
  app.get('/api/v1/video/local-media/index', async (request, reply) => {
    const parsed = localMediaIndexQuery.safeParse(request.query || {});
    if (!parsed.success || !dependencies.localMedia) return reply.code(422).send({ error: { code: 'LOCAL_MEDIA_INDEX_INVALID', message: '素材索引参数不完整。', details: parsed.success ? [] : parsed.error.issues } });
    const assets = await dependencies.localMedia.listIndex(parsed.data.projectId, { ...(parsed.data.query !== undefined ? { query: parsed.data.query } : {}), ...(parsed.data.orientation !== undefined ? { orientation: parsed.data.orientation } : {}), ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}), ...(parsed.data.usage !== undefined ? { usage: parsed.data.usage } : {}), ...(parsed.data.sort !== undefined ? { sort: parsed.data.sort } : {}) });
    return { items: assets.map(LocalMediaSourceService.toPublicFile), total: assets.length };
  });
  app.patch('/api/v1/video/local-media/index/:fileId', async (request, reply) => {
    const parsed = localMediaMetaInput.safeParse(request.body || {});
    if (!parsed.success || !dependencies.localMedia) return reply.code(422).send({ error: { code: 'LOCAL_MEDIA_INDEX_INVALID', message: '素材标签参数不正确。', details: parsed.success ? [] : parsed.error.issues } });
    const fileId = (request.params as { fileId: string }).fileId;
    if (parsed.data.category !== undefined) await dependencies.localMedia.updateCategory(fileId, parsed.data.category);
    if (parsed.data.tags !== undefined) await dependencies.localMedia.updateTags(fileId, parsed.data.tags);
    return { ok: true };
  });
  app.get('/api/v1/video/local-media/thumbnails/:fileId', async (request, reply) => {
    if (!dependencies.localMedia) return reply.code(403).send({ error: { code: 'LOCAL_MEDIA_ROOT_UNAUTHORIZED', message: '服务端尚未配置本地素材授权根目录。', details: [] } });
    const query = request.query as { projectId?: string };
    if (!query.projectId) return reply.code(422).send({ error: { code: 'PROJECT_REQUIRED', message: '缺少项目标识。', details: [] } });
    const result = await dependencies.localMedia.getThumbnail((request.params as { fileId: string }).fileId, query.projectId);
    if (!result) return reply.code(404).send({ error: { code: 'THUMBNAIL_NOT_FOUND', message: '缩略图尚未生成。', details: [] } });
    reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(createReadStream(result.path));
  });
  app.get('/api/v1/video/local-media/content', async (request, reply) => {
    const parsed = localMediaContentInput.safeParse(request.query || {});
    if (!parsed.success || !dependencies.localMedia) return reply.code(404).send({ error: { code: 'LOCAL_MEDIA_FILE_NOT_FOUND', message: '本地视频不存在。', details: [] } });
    const file = await dependencies.localMedia.getFile(parsed.data.sourceRootId, parsed.data.fileId, parsed.data.projectId);
    if (!file || !file.available) return reply.code(404).send({ error: { code: 'LOCAL_MEDIA_FILE_NOT_FOUND', message: '当前视频素材已不存在，请重新扫描素材文件夹。', details: [] } });
    const info = await stat(file.sourcePath).catch(() => null); if (!info?.isFile()) return reply.code(404).send({ error: { code: 'LOCAL_MEDIA_FILE_NOT_FOUND', message: '当前视频素材已不存在，请重新扫描素材文件夹。', details: [] } });
    const range = request.headers.range; const mime = ({ mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo' } as Record<string, string>)[extname(file.fileName).slice(1).toLowerCase()] || 'video/mp4';
    reply.header('accept-ranges', 'bytes').header('content-type', mime);
    if (!range) { reply.header('content-length', info.size); return reply.send(createReadStream(file.sourcePath)); }
    const match = /^bytes=(\d*)-(\d*)$/u.exec(range); if (!match) return reply.code(416).send();
    const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2] || 0)); const end = match[2] ? Number(match[2]) : info.size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= info.size) return reply.code(416).header('content-range', `bytes */${info.size}`).send();
    reply.code(206).header('content-length', end - start + 1).header('content-range', `bytes ${start}-${end}/${info.size}`); return reply.send(createReadStream(file.sourcePath, { start, end }));
  });

  app.post('/api/v1/projects/:projectId/video/montage-plans', async (request, reply) => {
    const projectId = projectIdOf(request); const parsed = montagePlanInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VIDEO_MONTAGE_INPUT_INVALID', message: '剪辑方案参数不完整。', details: parsed.error.issues } });
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: '项目不存在。', details: [] } });
    try {
      let plannerAssets: Array<{ id: string; storageKey: string; sourcePath: string; durationMs: number; originalName?: string; tags?: string[]; metadata?: Record<string, unknown> }>;
      let localPoolMeta: { localMediaSourceRootId: string; localMediaScanId: string } | null = null;
      if (parsed.data.sourceRoot || parsed.data.scanId) {
        if (!dependencies.localMedia) throw new Error('LOCAL_MEDIA_ROOT_UNAUTHORIZED');
        const scan = parsed.data.scanId ? await dependencies.localMedia.getScan(parsed.data.scanId, projectId) : await dependencies.localMedia.getLatestScan(projectId, dependencies.localMedia.authorizeRoot(parsed.data.sourceRoot!).sourceRootId);
        if (!scan || scan.status !== 'SUCCEEDED') throw new Error('LOCAL_MEDIA_SCAN_NOT_READY');
        plannerAssets = scan.files.filter((file) => file.available).map((file) => ({ id: `${scan.sourceRootId}:${file.relativePath}`, storageKey: `${scan.sourceRootId}:${file.relativePath}`, sourcePath: file.sourcePath, durationMs: file.durationMs, originalName: file.fileName, metadata: { width: file.width, height: file.height, format: file.format, relativePath: file.relativePath } }));
        localPoolMeta = { localMediaSourceRootId: scan.sourceRootId, localMediaScanId: scan.id };
      } else {
        const selected = await assets.listReadySourceAssets(projectId, parsed.data.videoAssetIds, 'VIDEO');
        if (selected.length !== new Set(parsed.data.videoAssetIds).size) throw new Error('VIDEO_SOURCE_ASSET_INVALID');
        plannerAssets = selected.map((asset) => ({ id: asset.id, storageKey: asset.storageKey, sourcePath: storage.objectPath(asset.storageKey), durationMs: Number(asset.metadata.durationMs || 0), ...(typeof asset.metadata.originalName === 'string' ? { originalName: asset.metadata.originalName } : asset.storageKey.split('/').at(-1) ? { originalName: asset.storageKey.split('/').at(-1)! } : {}), tags: Array.isArray(asset.metadata.tags) ? asset.metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [], metadata: asset.metadata }));
      }
      const sentences = (parsed.data.sentences || []).map((sentence, index) => ({ index, text: sentence.text, normalizedText: sentence.normalizedText || sentence.text.normalize('NFKC').toLowerCase(), ...(sentence.voiceStartMs !== undefined ? { voiceStartMs: sentence.voiceStartMs } : {}), ...(sentence.voiceEndMs !== undefined ? { voiceEndMs: sentence.voiceEndMs } : {}), ...(sentence.durationMs !== undefined ? { durationMs: sentence.durationMs } : {}) })) as TimedScriptSentence[];
      const effectiveSentences = sentences.length > 0 ? sentences : segmentScriptSentences(parsed.data.script || '');
      const result = parsed.data.mode === 'SCRIPT' ? buildScriptMontageManifest({ projectId, ...(parsed.data.script ? { script: parsed.data.script } : {}), sentences: effectiveSentences, assets: plannerAssets, seed: parsed.data.seed, minClipDurationMs: parsed.data.minClipDurationMs, maxClipDurationMs: parsed.data.maxClipDurationMs, ...(parsed.data.voiceAssetId ? { voiceAssetId: parsed.data.voiceAssetId } : {}) }) : buildRandomSentenceMontageManifest({ projectId, sentences: effectiveSentences, assets: plannerAssets, seed: parsed.data.seed, minClipDurationMs: parsed.data.minClipDurationMs, maxClipDurationMs: parsed.data.maxClipDurationMs, ...(parsed.data.voiceAssetId ? { voiceAssetId: parsed.data.voiceAssetId } : {}) });
      if (parsed.data.introAssetId || parsed.data.outroAssetId) {
        const brandingIds = [parsed.data.introAssetId, parsed.data.outroAssetId].filter((id): id is string => Boolean(id));
        const projectBrandingIds = brandingIds.filter((id) => !id.startsWith('local-'));
        const brandingAssets = projectBrandingIds.length ? await assets.listReadySourceAssets(projectId, projectBrandingIds, 'VIDEO') : [];
        const byId = new Map(brandingAssets.map((asset) => [asset.id, asset]));
        const toBranding = (id: string, durationMs: number | undefined) => {
          const asset = byId.get(id);
          if (asset) { const sourcePath = storage.objectPath(asset.storageKey); return { id: asset.id, storageKey: asset.storageKey, sourcePath, durationMs: durationMs || Number(asset.metadata.durationMs || 0), role: id === parsed.data.introAssetId ? 'INTRO' as const : 'OUTRO' as const }; }
          if (dependencies.localMedia && id.startsWith('local-')) { const rootId = id.split(':', 1)[0]!; return dependencies.localMedia.getFile(rootId, id, projectId).then((file) => { if (!file?.available) throw new Error('VIDEO_BRANDING_ASSET_INVALID'); return { id, storageKey: id, sourcePath: file.sourcePath, durationMs: durationMs || file.durationMs, role: id === parsed.data.introAssetId ? 'INTRO' as const : 'OUTRO' as const }; }); }
          throw new Error('VIDEO_BRANDING_ASSET_INVALID');
        };
        const intro = parsed.data.introAssetId ? await toBranding(parsed.data.introAssetId, parsed.data.introDurationMs) : undefined;
        const outro = parsed.data.outroAssetId ? await toBranding(parsed.data.outroAssetId, parsed.data.outroDurationMs) : undefined;
        result.manifest = assembleBrandedTimeline(result.manifest, { ...(intro ? { intro } : {}), ...(outro ? { outro } : {}) });
      }
      if (localPoolMeta) result.manifest.metadata = { ...(result.manifest.metadata || {}), ...localPoolMeta };
      const record = await quickEdit.createPlannedManifest({ projectId, manifest: result.manifest, createdBy: 'operator' });
      return reply.code(201).send({ ...safeManifestRecord(record) as Record<string, unknown>, decisions: result.decisions, sentences: result.sentences });
    } catch (error) {
      const message = error instanceof Error ? error.message : '剪辑方案生成失败。'; const code = message.includes('UNAUTHORIZED') ? 403 : message.includes('NOT_FOUND') ? 404 : 422;
      return reply.code(code).send({ error: { code: message, message: message === 'VIDEO_SOURCE_ASSET_INVALID' || message === 'VIDEO_BRANDING_ASSET_INVALID' ? '所选视频素材不可用。' : message === 'LOCAL_MEDIA_ROOT_UNAUTHORIZED' ? '该本地文件夹未被授权。' : '剪辑方案生成失败，请检查素材和脚本文案。', details: [] } });
    }
  });

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
  app.post('/api/v1/video/quick-edits/:id/voice', async (request, reply) => {
    const parsed = standaloneVoiceInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid voice asset input', details: parsed.error.issues } });
    try { return reply.code(200).send(await standaloneQuickEdit.setVoiceAsset((request.params as { id: string }).id, parsed.data.assetId)); }
    catch (error) { return reply.code(409).send({ error: { code: 'STANDALONE_VOICE_CONFLICT', message: error instanceof Error ? error.message : 'Voice asset selection rejected', details: [] } }); }
  });
  app.patch('/api/v1/video/quick-edits/:id/settings', async (request, reply) => {
    const parsed = standaloneSettingsInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid planner settings', details: parsed.error.issues } });
    try {
      const settings = { ...(parsed.data.seed !== undefined ? { seed: parsed.data.seed } : {}), ...(parsed.data.targetDurationMs !== undefined ? { targetDurationMs: parsed.data.targetDurationMs } : {}), ...(parsed.data.minClipDurationMs !== undefined ? { minClipDurationMs: parsed.data.minClipDurationMs } : {}), ...(parsed.data.maxClipDurationMs !== undefined ? { maxClipDurationMs: parsed.data.maxClipDurationMs } : {}) };
      return reply.code(200).send(await standaloneQuickEdit.updateSettings((request.params as { id: string }).id, settings));
    }
    catch (error) { return reply.code(409).send({ error: { code: 'STANDALONE_SETTINGS_CONFLICT', message: error instanceof Error ? error.message : 'Planner settings update rejected', details: [] } }); }
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
  app.get('/api/v1/video/quick-edits/:id/manifests/:manifestId', async (request, reply) => {
    const { id, manifestId } = request.params as { id: string; manifestId: string };
    const session = await standaloneQuickEdit.get(id);
    if (!session) return reply.code(404).send({ error: { code: 'STANDALONE_QUICK_EDIT_NOT_FOUND', message: 'Standalone Quick Edit not found', details: [] } });
    const manifest = await quickEdit.getManifest('', manifestId, session.workspaceId);
    return manifest ? safeManifestRecord(manifest) : reply.code(404).send({ error: { code: 'VIDEO_MANIFEST_NOT_FOUND', message: 'Video Manifest not found', details: [] } });
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
    reply.header('content-type', mediaContentType(asset));
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
