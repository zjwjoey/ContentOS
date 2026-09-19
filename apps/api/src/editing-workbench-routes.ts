import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants, copyFile, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { VideoAdjustmentService, VideoEditPresetService, VideoService } from '../../../packages/modules/video/src/index.js';
import type { JobService } from '../../../packages/modules/job/src/index.js';
import type { AssetCatalogService, LocalMediaSourceService } from '../../../packages/modules/asset/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';

const itemInput = z.object({ title: z.string().trim().max(200).optional(), script: z.string().trim().min(1).max(100_000), voiceAssetId: z.string().trim().min(1).optional(), voicePath: z.string().trim().min(1).optional() });
const pairInput = z.object({ textFiles: z.array(z.string().trim().min(1)).max(500), audioFiles: z.array(z.string().trim().min(1)).max(500), includeContent: z.boolean().default(false) });
const sessionInput = z.object({ mode: z.enum(['SCRIPT', 'MIX']), title: z.string().trim().max(200).optional(), script: z.string().trim().max(100_000).optional(), voicePath: z.string().trim().min(1).optional(), items: z.array(itemInput).min(1).max(100).optional(), testOnly: z.boolean().default(false), sourceRoots: z.array(z.string().trim().min(1)).max(16).default([]), outputRoot: z.string().trim().min(1).optional(), templateId: z.string().trim().min(1).optional(), seed: z.number().int().optional(), variants: z.number().int().refine((value) => value === 1 || value === 3 || value === 5, '版本数只能是 1、3 或 5。').default(1), fps: z.number().int().min(1).max(120).default(30), minClipDurationMs: z.number().int().positive().default(2_000), maxClipDurationMs: z.number().int().positive().default(5_000), preferUnusedMedia: z.boolean().default(true), usePexels: z.boolean().default(false) }).superRefine((value, ctx) => { if (value.mode === 'SCRIPT' && !value.script?.trim() && !value.items?.[0]?.script) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['script'], message: '请输入文案。' }); if (value.mode === 'MIX' && (!value.items || value.items.length === 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '请至少添加一条文案。' }); if (value.mode === 'MIX' && value.usePexels) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['usePexels'], message: 'Pexels 混合素材暂只支持脚本剪辑。' }); if (!value.outputRoot) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputRoot'], message: '请填写输出文件夹。' }); if (value.maxClipDurationMs < value.minClipDurationMs) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxClipDurationMs'], message: '最长镜头不能短于最短镜头。' }); });

export interface EditingWorkbenchRouteDependencies { db: Pool; localMedia: LocalMediaSourceService; quickEdit: VideoAdjustmentService; video: VideoService; jobs: JobService; assets: AssetCatalogService; assetService: import('../../../packages/modules/asset/src/index.js').AssetService; storage: LocalStorageProvider; maxUploadBytes?: number; presets?: VideoEditPresetService; }

function allowedOutputRoots(): string[] { return (process.env.CONTENTOS_OUTPUT_ROOTS || '').split(';').map((value) => value.trim()).filter(Boolean).map((value) => resolve(value)); }
function contained(root: string, candidate: string): boolean { const normalized = root.endsWith(sep) ? root : `${root}${sep}`; return candidate.toLowerCase() === root.toLowerCase() || candidate.toLowerCase().startsWith(normalized.toLowerCase()); }
async function authorizeOutputRoot(input: string): Promise<string> {
  if (!input || input.includes('\0')) throw new Error('EDIT_OUTPUT_ROOT_INVALID');
  const root = resolve(input);
  const allowed = allowedOutputRoots();
  let actualRoot: string;
  try { actualRoot = await realpath(root); } catch { throw new Error('EDIT_OUTPUT_ROOT_NOT_FOUND'); }
  const authorized = await Promise.all(allowed.map(async (candidate) => { try { return await realpath(candidate); } catch { return null; } }));
  if (!authorized.some((candidate) => candidate && contained(candidate, actualRoot))) throw new Error('EDIT_OUTPUT_ROOT_UNAUTHORIZED');
  const details = await stat(actualRoot).catch(() => null);
  if (!details?.isDirectory()) throw new Error('EDIT_OUTPUT_ROOT_NOT_FOUND');
  try { await access(actualRoot, constants.W_OK); } catch { throw new Error('EDIT_OUTPUT_ROOT_NOT_WRITABLE'); }
  return actualRoot;
}
export function cleanFilePart(value: string): string { return value.replace(/[\\/:*?"<>|]/gu, '_').replace(/[. ]+$/u, '').trim().slice(0, 120) || '未命名'; }
export function outputFileStem(title: string, ordinal: number, variantIndex = 0, variantCount = 1): string {
  const cleanTitle = cleanFilePart(title);
  const base = `${String(ordinal).padStart(3, '0')}_${variantCount > 1 ? cleanTitle.replace(/_[A-E]$/u, '') : cleanTitle}`;
  return variantCount > 1 ? `${base}_${String.fromCharCode(65 + variantIndex)}` : base;
}
export function renderRetryIdempotencySuffix(itemId: string, previousJobId: string | null | undefined): string { return `edit-retry:${itemId}:${previousJobId || 'initial'}`; }
export async function promoteStagedUpload(stagedPath: string, destination: string): Promise<void> {
  const sameVolumePart = `${destination}.${randomUUID()}.part`;
  try {
    await copyFile(stagedPath, sameVolumePart);
    if (await stat(destination).then(() => true).catch(() => false)) throw new Error('EDIT_UPLOAD_DESTINATION_EXISTS');
    await rename(sameVolumePart, destination);
  } finally {
    await rm(sameVolumePart, { force: true }).catch(() => undefined);
    await rm(stagedPath, { force: true }).catch(() => undefined);
  }
}
type PairStatus = 'READY' | 'MISSING_AUDIO' | 'MISSING_TEXT' | 'DUPLICATE_TEXT_BASENAME' | 'DUPLICATE_AUDIO_BASENAME' | 'DUPLICATE_BASENAME';
function normalizedPairBasename(file: string): string {
  const name = basename(file).normalize('NFKC').trim();
  return name.replace(extname(name), '').trim().toLocaleLowerCase();
}
export function pairByBasename(textFiles: string[], audioFiles: string[]): Array<{ ordinal: number; basename: string; textFile: string | null; audioFile: string | null; status: PairStatus }> {
  const collect = (files: string[], pattern: RegExp) => {
    const map = new Map<string, string[]>();
    for (const file of files.filter((candidate) => pattern.test(candidate))) {
      const key = normalizedPairBasename(file);
      const values = map.get(key) || [];
      values.push(file);
      map.set(key, values);
    }
    return map;
  };
  const texts = collect(textFiles, /\.(txt|md)$/iu);
  const audios = collect(audioFiles, /\.(mp3|wav|m4a|aac)$/iu);
  return [...new Set([...texts.keys(), ...audios.keys()])].sort().map((key, index) => {
    const text = texts.get(key) || [];
    const audio = audios.get(key) || [];
    const duplicateText = text.length > 1;
    const duplicateAudio = audio.length > 1;
    const status: PairStatus = duplicateText && duplicateAudio ? 'DUPLICATE_BASENAME' : duplicateText ? 'DUPLICATE_TEXT_BASENAME' : duplicateAudio ? 'DUPLICATE_AUDIO_BASENAME' : text.length && audio.length ? 'READY' : text.length ? 'MISSING_AUDIO' : 'MISSING_TEXT';
    return { ordinal: index + 1, basename: key, textFile: text[0] || null, audioFile: audio[0] || null, status };
  });
}
async function pairWithContent(textFiles: string[], audioFiles: string[]): Promise<Array<Record<string, unknown>>> {
  const pairs = pairByBasename(textFiles, audioFiles);
  return await Promise.all(pairs.map(async (pair) => {
    if (pair.status !== 'READY' || !pair.textFile || !pair.audioFile) return pair;
    await assertSafeSourceFile(pair.textFile);
    await assertSafeSourceFile(pair.audioFile);
    const details = await stat(pair.textFile).catch(() => null);
    if (!details?.isFile() || details.size > 100_000) throw new Error('EDIT_PAIR_TEXT_INVALID');
    const script = (await readFile(pair.textFile, 'utf8')).trim();
    return { ...pair, script, voicePath: pair.audioFile };
  }));
}
function itemTitle(item: { title?: string | undefined; script: string }, ordinal: number): string { return cleanFilePart(item.title?.trim() || item.script.split(/[\r\n。！？!?]/u)[0]?.trim() || `任务${ordinal}`); }
function stableItemSeed(batchId: string, sourceItemOrdinal: number, variantIndex: number, requestedSeed: number): number {
  const digest = createHash('sha256').update(`${batchId}:${sourceItemOrdinal}:${variantIndex}:${requestedSeed}`).digest('hex');
  return (Number.parseInt(digest.slice(0, 8), 16) % 2_147_483_646) + 1;
}
function friendlyEditError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'VIDEO_SOURCE_ASSET_INVALID' || code === 'EDIT_NO_VIDEO_ASSETS') return '没有找到可用于剪辑的视频素材。';
  if (code === 'VIDEO_MANIFEST_VOICE_UNAVAILABLE' || code === 'EDIT_VOICE_PATH_UNAUTHORIZED') return '配音文件不可用，请重新选择。';
  if (code === 'LOCAL_MEDIA_ROOT_UNAUTHORIZED') return '素材目录未被授权。';
  if (code === 'LOCAL_MEDIA_ROOT_NOT_FOUND') return '素材路径不存在或不是文件夹。';
  if (code === 'ENOENT') return '素材文件已不存在。';
  return '这一条任务准备失败，可修改后复制任务重试。';
}
function publicItem(row: Record<string, unknown>, job?: Record<string, unknown> | null): Record<string, unknown> {
  const state = row.state || 'QUEUED';
  const snapshot = row.settings_snapshot && typeof row.settings_snapshot === 'object' && !Array.isArray(row.settings_snapshot) ? row.settings_snapshot as Record<string, unknown> : {};
  const diagnostics = snapshot.hybridDiagnostics && typeof snapshot.hybridDiagnostics === 'object' && !Array.isArray(snapshot.hybridDiagnostics) ? snapshot.hybridDiagnostics as Record<string, unknown> : undefined;
  return { id: String(row.id), ordinal: Number(row.ordinal), title: String(row.title), script: String(row.script), state, phase: typeof snapshot.phase === 'string' ? snapshot.phase : undefined, sourceStats: diagnostics ? { localCount: Number(diagnostics.localCount || 0), externalCount: Number(diagnostics.externalCount || 0), fallbackCount: Number(diagnostics.fallbackCount || 0), genericFallbackCount: Number(diagnostics.genericFallbackCount || 0), warnings: Array.isArray(diagnostics.warnings) ? diagnostics.warnings : [] } : undefined, jobId: row.job_id ? String(row.job_id) : undefined, outputAssetId: row.output_asset_id ? String(row.output_asset_id) : undefined, outputPath: row.output_path ? String(row.output_path) : undefined, error: row.error || job?.error || undefined, exportId: row.export_id ? String(row.export_id) : undefined, exportStatus: row.export_status ? String(row.export_status) : undefined, exportError: row.export_error || undefined };
}
type EffectiveItemState = 'QUEUED' | 'PREPARING' | 'RENDERING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
function effectiveItemState(row: Record<string, unknown>, jobState?: unknown): EffectiveItemState {
  const persisted = String(row.state || 'QUEUED');
  if (persisted === 'FAILED') return 'FAILED';
  if (persisted === 'CANCELLED') return 'CANCELLED';
  const state = String(jobState || '');
  if (state === 'SUCCEEDED') return 'SUCCEEDED';
  if (state === 'FAILED' || state === 'BLOCKED') return 'FAILED';
  if (state === 'CANCELLED' || state === 'CANCEL_REQUESTED') return 'CANCELLED';
  if (row.prepare_job_id && !row.job_id) return 'PREPARING';
  if (row.job_id) return 'RENDERING';
  return ['QUEUED', 'PREPARING', 'RENDERING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(persisted) ? persisted as EffectiveItemState : 'QUEUED';
}

async function assertSafeSourceRoot(sourceRoot: string): Promise<void> {
  const configured = (process.env.CONTENTOS_LOCAL_MEDIA_ROOTS || '').split(';').map((value) => value.trim()).filter(Boolean).map((value) => resolve(value));
  if (configured.length === 0) throw new Error('LOCAL_MEDIA_ROOT_UNAUTHORIZED');
  const candidate = await realpath(resolve(sourceRoot)).catch(() => null);
  if (!candidate) throw new Error('LOCAL_MEDIA_ROOT_NOT_FOUND');
  const authorized = await Promise.all(configured.map(async (root) => { try { return await realpath(root); } catch { return null; } }));
  if (!authorized.some((root) => root && contained(root, candidate))) throw new Error('LOCAL_MEDIA_ROOT_UNAUTHORIZED');
  const details = await stat(candidate).catch(() => null);
  if (!details?.isDirectory()) throw new Error('LOCAL_MEDIA_ROOT_NOT_FOUND');
}

async function assertSafeSourceFile(sourceFile: string): Promise<void> {
  const configured = (process.env.CONTENTOS_LOCAL_MEDIA_ROOTS || '').split(';').map((value) => value.trim()).filter(Boolean).map((value) => resolve(value));
  if (configured.length === 0) throw new Error('LOCAL_MEDIA_ROOT_UNAUTHORIZED');
  const candidate = await realpath(resolve(sourceFile)).catch(() => null);
  if (!candidate) throw new Error('LOCAL_MEDIA_ROOT_NOT_FOUND');
  const authorized = await Promise.all(configured.map(async (root) => { try { return await realpath(root); } catch { return null; } }));
  if (!authorized.some((root) => root && contained(root, candidate))) throw new Error('LOCAL_MEDIA_ROOT_UNAUTHORIZED');
  const details = await stat(candidate).catch(() => null);
  if (!details?.isFile()) throw new Error('LOCAL_MEDIA_ROOT_NOT_FOUND');
}

async function scanRoots(localMedia: LocalMediaSourceService, roots: string[], workspaceId?: string) {
  const uniqueRoots = [...new Set(roots.map((root) => resolve(root.trim())))];
  const scans = await Promise.all(uniqueRoots.map(async (sourceRoot) => {
    await assertSafeSourceRoot(sourceRoot);
    const scanId = workspaceId ? `edit-scan-${randomUUID()}` : undefined;
    if (scanId && workspaceId) await localMedia.createScan({ id: scanId, workspaceId, sourceRoot, recursive: true });
    if (scanId) await localMedia.markScanRunning(scanId);
    try {
      const scan = await localMedia.scan({ sourceRoot, recursive: true });
      if (scanId) await localMedia.completeScan(scanId, scan);
      return { ...(scanId ? { scanId } : {}), sourceRoot: scan.sourceRootId, path: sourceRoot, total: scan.totalCount, available: scan.availableCount, unavailable: scan.unavailableCount, files: scan.files.filter((file) => file.available).map((file) => ({ id: `${scan.sourceRootId}:${file.relativePath}`, storageKey: `${scan.sourceRootId}:${file.relativePath}`, sourcePath: file.sourcePath, durationMs: file.durationMs, originalName: file.fileName, tags: file.tags, metadata: { width: file.width, height: file.height, format: file.format, relativePath: file.relativePath } })) };
    } catch (error) {
      if (scanId) await localMedia.failScan(scanId, error);
      throw error;
    }
  }));
  const byId = new Map<string, (typeof scans)[number]['files'][number]>();
  for (const scan of scans) for (const file of scan.files) if (!byId.has(file.id)) byId.set(file.id, file);
  return { scans, assets: [...byId.values()] };
}

export function registerEditingWorkbenchRoutes(app: FastifyInstance, dependencies: EditingWorkbenchRouteDependencies): void {
  app.post('/api/v1/edit/pair', async (request, reply) => {
    const parsed = pairInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'EDIT_PAIR_INVALID', message: '文案和音频文件列表不正确。', details: parsed.error.issues } });
    try { return { items: parsed.data.includeContent ? await pairWithContent(parsed.data.textFiles, parsed.data.audioFiles) : pairByBasename(parsed.data.textFiles, parsed.data.audioFiles) }; }
    catch (error) { const code = error instanceof Error ? error.message : 'EDIT_PAIR_FAILED'; const message = code === 'LOCAL_MEDIA_ROOT_UNAUTHORIZED' ? '文案或音频文件未被授权，请检查素材根目录配置。' : '文案文件无法读取，请检查路径和文件大小。'; return reply.code(code === 'LOCAL_MEDIA_ROOT_UNAUTHORIZED' ? 403 : 422).send({ error: { code, message, details: [] } }); }
  });

  app.get('/api/v1/edit/presets', async () => ({ items: dependencies.presets ? await dependencies.presets.list() : [] }));

  app.get('/api/v1/edit/permissions', async () => ({
    localMediaRoots: (process.env.CONTENTOS_LOCAL_MEDIA_ROOTS || '').split(';').map((value) => value.trim()).filter(Boolean).map((value) => resolve(value)),
    outputRoots: allowedOutputRoots(),
  }));

  app.post('/api/v1/edit/uploads/audio', async (request, reply) => {
    const part = await request.file();
    if (!part) return reply.code(422).send({ error: { code: 'EDIT_AUDIO_UPLOAD_REQUIRED', message: '请选择一个音频文件。', details: [] } });
    const extension = extname(part.filename).toLowerCase();
    if (!part.mimetype.startsWith('audio/') && !['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(extension)) { await part.file.resume(); return reply.code(422).send({ error: { code: 'EDIT_AUDIO_UPLOAD_INVALID', message: '这里只支持音频文件。', details: [] } }); }
    if (!['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(extension)) { await part.file.resume(); return reply.code(422).send({ error: { code: 'EDIT_AUDIO_UPLOAD_INVALID', message: '支持 mp3、wav、m4a、aac、flac 或 ogg。', details: [] } }); }
    const configured = (process.env.CONTENTOS_LOCAL_MEDIA_ROOTS || '').split(';').map((value) => value.trim()).filter(Boolean).map((value) => resolve(value));
    if (configured.length === 0) return reply.code(403).send({ error: { code: 'LOCAL_MEDIA_ROOT_UNAUTHORIZED', message: '未配置可写入的本地素材根目录。', details: [] } });
    let staged: Awaited<ReturnType<LocalStorageProvider['stageUpload']>> | undefined;
    try {
      const sourceRoot = dependencies.localMedia.authorizeRoot(configured[0]!).root;
      const uploadRoot = join(sourceRoot, '.contentos-uploads');
      await mkdir(uploadRoot, { recursive: true });
      const actualUploadRoot = await realpath(uploadRoot);
      if (!contained(sourceRoot, actualUploadRoot)) throw new Error('LOCAL_MEDIA_ROOT_UNAUTHORIZED');
      staged = await dependencies.storage.stageUpload(part.filename, part.file, dependencies.maxUploadBytes || 500 * 1024 * 1024);
      const destination = join(actualUploadRoot, `${randomUUID()}${extension}`);
      // The storage staging directory may be on another volume. Copy into a
      // target-root .part file first, then promote with an atomic same-volume
      // rename so the final path is safe on Windows and POSIX alike.
      await promoteStagedUpload(staged.tempPath, destination);
      staged = undefined;
      return reply.code(201).send({ name: part.filename, path: destination });
    } catch (error) {
      if (staged) await rm(staged.tempPath, { force: true }).catch(() => undefined);
      const code = error instanceof Error ? error.message : 'EDIT_AUDIO_UPLOAD_FAILED';
      const message = code === 'UPLOAD_TOO_LARGE' ? '音频文件过大。' : code === 'EMPTY_UPLOAD' ? '音频文件不能为空。' : code === 'LOCAL_MEDIA_ROOT_UNAUTHORIZED' ? '本地素材根目录未授权。' : '音频上传失败，请检查文件后重试。';
      return reply.code(code === 'LOCAL_MEDIA_ROOT_UNAUTHORIZED' ? 403 : code === 'UPLOAD_TOO_LARGE' ? 413 : 422).send({ error: { code, message, details: [] } });
    }
  });

  app.post('/api/v1/edit/sessions', async (request, reply) => {
    const parsed = sessionInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'EDIT_INPUT_INVALID', message: '请检查文案、素材目录和剪辑参数。', details: parsed.error.issues } });
    try {
      const input = parsed.data;
      const outputRoot = input.outputRoot ? await authorizeOutputRoot(input.outputRoot) : null;
      if (input.usePexels && !process.env.PEXELS_API_KEY && process.env.CONTENTOS_FAKE_PEXELS !== '1') throw new Error('PEXELS_NOT_CONFIGURED');
      const sessionId = `edit-session-${randomUUID()}`;
      const sourceWorkspaceId = `workspace-edit-source-${randomUUID()}`;
      await dependencies.db.query("insert into video_workspaces (id, type, project_id) values ($1, 'STANDALONE', null)", [sourceWorkspaceId]);
      const scanned = input.sourceRoots.length ? await scanRoots(dependencies.localMedia, input.sourceRoots, sourceWorkspaceId) : { scans: [], assets: [] };
      if (scanned.assets.length === 0 && !input.usePexels) throw new Error('EDIT_NO_VIDEO_ASSETS');
      const batchId = `edit-batch-${randomUUID()}`;
      const title = cleanFilePart(input.title || (input.mode === 'SCRIPT' ? '脚本剪辑' : '批量混剪'));
      const requestedItems = input.mode === 'SCRIPT' ? [{ script: input.script?.trim() || input.items?.[0]?.script || '', title, voiceAssetId: input.items?.[0]?.voiceAssetId, voicePath: input.voicePath || input.items?.[0]?.voicePath }] : (input.items || []);
      const expandedItems = requestedItems.flatMap((item, sourceIndex) => Array.from({ length: input.variants }, (_, variantIndex) => ({ ...item, sourceItemOrdinal: sourceIndex + 1, variantIndex })));
      const items = input.testOnly ? expandedItems.slice(0, 1) : expandedItems;
      const durableItems = items.map((item, index) => ({ item, index, itemId: `edit-item-${randomUUID()}`, workspaceId: `workspace-edit-${randomUUID()}`, titleForItem: itemTitle(item, index + 1) }));
      const transaction = await dependencies.db.connect();
      try {
        await transaction.query('begin');
        await transaction.query('insert into edit_workbench_sessions (id, mode, title, script, source_roots, output_root, settings) values ($1,$2,$3,$4,$5,$6,$7)', [sessionId, input.mode, title, input.script || null, JSON.stringify(scanned.scans.map(({ files: _files, ...scan }) => scan)), outputRoot, { seed: input.seed ?? 1, variants: input.variants, fps: input.fps, minClipDurationMs: input.minClipDurationMs, maxClipDurationMs: input.maxClipDurationMs, preferUnusedMedia: input.preferUnusedMedia, usePexels: input.usePexels, testOnly: input.testOnly, sourceWorkspaceId, requestedItems, scanAssets: scanned.assets, ...(input.templateId ? { templateId: input.templateId } : {}) }]);
        await transaction.query('insert into edit_batches (id, session_id, mode, status, total_count) values ($1,$2,$3,$4,$5)', [batchId, sessionId, input.mode, 'RUNNING', durableItems.length]);
        for (const durable of durableItems) {
          await transaction.query("insert into video_workspaces (id, type, project_id) values ($1, 'STANDALONE', null)", [durable.workspaceId]);
          await transaction.query('insert into edit_batch_items (id,batch_id,ordinal,source_item_ordinal,variant_index,title,script,voice_asset_id,voice_path,workspace_id,state,settings_snapshot) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [durable.itemId, batchId, durable.index + 1, durable.item.sourceItemOrdinal, durable.item.variantIndex, durable.titleForItem, durable.item.script, durable.item.voiceAssetId || null, durable.item.voicePath || null, durable.workspaceId, 'QUEUED', { seed: stableItemSeed(batchId, Number(durable.item.sourceItemOrdinal), Number(durable.item.variantIndex), input.seed ?? 1), mode: input.mode, fps: input.fps, minClipDurationMs: input.minClipDurationMs, maxClipDurationMs: input.maxClipDurationMs, preferUnusedMedia: input.preferUnusedMedia, templateId: input.templateId || null }]);
        }
        await transaction.query('commit');
      } catch (error) {
        await transaction.query('rollback').catch(() => undefined);
        throw error;
      } finally { transaction.release(); }
      const resultItems: Record<string, unknown>[] = [];
      for (const durable of durableItems) {
        const prepareJob = await dependencies.jobs.createIdempotent({ id: `job-${randomUUID()}`, projectId: null, workspaceId: durable.workspaceId, type: 'EDIT_PREPARE_ITEM', payload: { batchId, itemId: durable.itemId, workspaceId: durable.workspaceId }, idempotencyKey: `edit-prepare:${durable.itemId}`, maxAttempts: 3 });
        await dependencies.db.query("update edit_batch_items set prepare_job_id=$2,state='PREPARING',updated_at=now() where id=$1", [durable.itemId, prepareJob.id]);
        resultItems.push({ id: durable.itemId, ordinal: durable.index + 1, title: durable.titleForItem, script: durable.item.script, state: 'PREPARING' });
      }
      await dependencies.db.query('update edit_batches set status=$2,succeeded_count=0,failed_count=0,updated_at=now() where id=$1', [batchId, 'RUNNING']);
      return reply.code(201).send({ id: sessionId, batchId, mode: input.mode, title, testOnly: input.testOnly, variants: input.variants, sources: scanned.scans.map(({ files: _files, ...scan }) => scan), outputRoot, items: resultItems });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'EDIT_SESSION_CREATE_FAILED';
      const message = code === 'PEXELS_NOT_CONFIGURED' ? '服务端尚未配置 PEXELS_API_KEY，请到部署环境设置。' : code === 'EDIT_OUTPUT_ROOT_UNAUTHORIZED' ? '输出目录未被授权，请配置允许的输出根目录。' : code === 'EDIT_OUTPUT_ROOT_NOT_FOUND' ? '输出目录不存在，请先创建目录。' : code === 'EDIT_OUTPUT_ROOT_NOT_WRITABLE' ? '输出目录不可写，请检查权限。' : code === 'LOCAL_MEDIA_ROOT_UNAUTHORIZED' ? '素材目录未被授权，请检查本地素材根目录配置。' : code === 'EDIT_NO_VIDEO_ASSETS' ? '没有找到可用于剪辑的视频素材。' : code === 'EDIT_TEMPLATE_NOT_FOUND' ? '剪辑模板不存在，请重新选择。' : '剪辑任务创建失败，请检查路径和素材。';
      return reply.code(code.includes('UNAUTHORIZED') ? 403 : 422).send({ error: { code, message, details: [] } });
    }
  });

  app.post('/api/v1/edit/sources/scan', async (request, reply) => {
    const parsed = z.object({ sourceRoots: z.array(z.string().trim().min(1)).min(1).max(16) }).safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'EDIT_SOURCE_SCAN_INVALID', message: '素材目录信息不正确。', details: parsed.error.issues } });
    try {
      const scanned = await scanRoots(dependencies.localMedia, parsed.data.sourceRoots);
      return { items: scanned.scans.map(({ files: _files, ...scan }) => scan) };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'EDIT_SOURCE_SCAN_FAILED';
      const message = code === 'LOCAL_MEDIA_ROOT_UNAUTHORIZED' ? '素材目录未被授权，请检查本地素材根目录配置。' : code === 'LOCAL_MEDIA_ROOT_NOT_FOUND' ? '素材目录不存在。' : '素材目录扫描失败，请检查路径和权限。';
      return reply.code(code === 'LOCAL_MEDIA_ROOT_UNAUTHORIZED' ? 403 : 422).send({ error: { code, message, details: [] } });
    }
  });

  app.get('/api/v1/edit/batches/:batchId', async (request, reply) => {
    const batchId = String((request.params as { batchId: string }).batchId);
    const pageQuery = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(100) }).safeParse(request.query || {});
    if (!pageQuery.success) return reply.code(422).send({ error: { code: 'EDIT_BATCH_INVALID', message: '批次分页参数不正确。', details: pageQuery.error.issues } });
    const batch = (await dependencies.db.query('select b.*, s.title, s.mode, s.output_root, s.settings from edit_batches b join edit_workbench_sessions s on s.id = b.session_id where b.id = $1', [batchId])).rows[0] as Record<string, unknown> | undefined;
    if (!batch) return reply.code(404).send({ error: { code: 'EDIT_BATCH_NOT_FOUND', message: '剪辑记录不存在。', details: [] } });
    const offset = (pageQuery.data.page - 1) * pageQuery.data.pageSize;
    const summary = (await dependencies.db.query("select count(*)::int as total, count(*) filter (where (case when i.state='FAILED' then 'FAILED' when i.state='CANCELLED' then 'CANCELLED' when j.state = 'SUCCEEDED' then 'SUCCEEDED' when j.state in ('FAILED','BLOCKED') or p.state in ('FAILED','BLOCKED') then 'FAILED' when j.state in ('CANCELLED','CANCEL_REQUESTED') then 'CANCELLED' when j.state in ('QUEUED','RUNNING','RETRY_WAIT') then 'RENDERING' when p.state in ('QUEUED','RUNNING','RETRY_WAIT') then 'PREPARING' else i.state end) = 'SUCCEEDED')::int as succeeded, count(*) filter (where (case when i.state='FAILED' then 'FAILED' when i.state='CANCELLED' then 'CANCELLED' when j.state in ('FAILED','BLOCKED') or p.state in ('FAILED','BLOCKED') then 'FAILED' else i.state end) = 'FAILED')::int as failed, count(*) filter (where (case when i.state in ('FAILED','CANCELLED','SUCCEEDED') then i.state when j.state in ('QUEUED','RUNNING','RETRY_WAIT') then 'RENDERING' when p.state in ('QUEUED','RUNNING','RETRY_WAIT') then 'PREPARING' else i.state end) in ('QUEUED','RUNNING','RETRY_WAIT','PREPARING','RENDERING'))::int as active from edit_batch_items i left join jobs j on j.id = i.job_id left join jobs p on p.id = i.prepare_job_id where i.batch_id = $1", [batchId])).rows[0] as { total?: number; succeeded?: number; failed?: number; active?: number } | undefined;
    const rows = (await dependencies.db.query(`select i.*, j.state as job_state, j.result as job_result, j.error as job_error,
      p.state as prepare_job_state, p.error as prepare_job_error,
      e.id as export_id, e.status as export_status, e.error as export_error
      from edit_batch_items i left join jobs j on j.id = i.job_id
      left join jobs p on p.id = i.prepare_job_id
      left join lateral (select id, status, error from edit_exports where batch_item_id = i.id order by created_at desc, id desc limit 1) e on true
      where i.batch_id = $1 order by i.ordinal limit $2 offset $3`, [batchId, pageQuery.data.pageSize, offset])).rows as Record<string, unknown>[];
    const items = await Promise.all(rows.map(async (row) => {
      const job = row.job_id ? { state: row.job_state, result: row.job_result, error: row.job_error } : row.prepare_job_id ? { state: row.prepare_job_state, result: null, error: row.prepare_job_error } : null;
      const result = job?.result && typeof job.result === 'object' ? job.result as { outputAssetId?: string } : {};
      const state = effectiveItemState(row, job?.state);
      return publicItem({ ...row, state, ...(result.outputAssetId ? { output_asset_id: result.outputAssetId } : {}) }, job as unknown as Record<string, unknown> | null);
    }));
    const actualTotal = Number(summary?.total || 0); const expectedTotal = Number(batch.total_count || 0); const succeeded = Number(summary?.succeeded || 0); const failed = Number(summary?.failed || 0); const active = Number(summary?.active || 0); const incomplete = actualTotal !== expectedTotal;
    const status = incomplete ? 'FAILED' : active > 0 ? 'RUNNING' : failed > 0 && succeeded > 0 ? 'PARTIAL' : expectedTotal > 0 && failed === expectedTotal ? 'FAILED' : expectedTotal > 0 && succeeded === expectedTotal ? 'SUCCEEDED' : 'RUNNING';
    const reportedFailed = failed + (incomplete && expectedTotal > actualTotal ? expectedTotal - actualTotal : 0);
    const settings = batch.settings && typeof batch.settings === 'object' && !Array.isArray(batch.settings) ? batch.settings as Record<string, unknown> : {};
    const exportSummary = (await dependencies.db.query("select count(*) filter (where e.status='SUCCEEDED')::int as exported, count(*) filter (where e.status in ('QUEUED','RUNNING'))::int as queued, count(*) filter (where e.status='FAILED')::int as export_failed from edit_exports e join edit_batch_items i on i.id=e.batch_item_id where i.batch_id=$1", [batchId])).rows[0] as { exported?: number; queued?: number; export_failed?: number } | undefined;
    return { id: batchId, title: String(batch.title), mode: String(batch.mode), testOnly: settings.testOnly === true, status, totalCount: expectedTotal, actualItemCount: actualTotal, consistency: incomplete ? { code: 'BATCH_INCOMPLETE', expected: expectedTotal, actual: actualTotal } : { code: 'OK', expected: expectedTotal, actual: actualTotal }, succeededCount: succeeded, failedCount: reportedFailed, exportTotalCount: Number(exportSummary?.exported || 0) + Number(exportSummary?.queued || 0) + Number(exportSummary?.export_failed || 0), exportedCount: Number(exportSummary?.exported || 0), exportQueuedCount: Number(exportSummary?.queued || 0), exportFailedCount: Number(exportSummary?.export_failed || 0), page: pageQuery.data.page, pageSize: pageQuery.data.pageSize, items };
  });

  app.get('/api/v1/edit/history', async (request, reply) => {
    const parsed = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'EDIT_HISTORY_INVALID', message: '历史记录分页参数不正确。', details: parsed.error.issues } });
    const offset = (parsed.data.page - 1) * parsed.data.pageSize;
    const rows = await dependencies.db.query('select b.id, b.mode, b.status, b.total_count, b.succeeded_count, b.failed_count, b.created_at, s.title, s.output_root, s.settings from edit_batches b join edit_workbench_sessions s on s.id = b.session_id order by b.created_at desc limit $1 offset $2', [parsed.data.pageSize, offset]);
    return { page: parsed.data.page, pageSize: parsed.data.pageSize, items: rows.rows.map((row) => ({ id: String(row.id), title: String(row.title), mode: String(row.mode), status: String(row.status), totalCount: Number(row.total_count), succeededCount: Number(row.succeeded_count), failedCount: Number(row.failed_count), createdAt: new Date(String(row.created_at)).toISOString(), outputRoot: row.output_root || null, testOnly: Boolean(row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings) && (row.settings as Record<string, unknown>).testOnly === true) })) };
  });

  app.get('/api/v1/edit/batches/:batchId/config', async (request, reply) => {
    const batchId = String((request.params as { batchId: string }).batchId);
    const row = (await dependencies.db.query('select b.id, b.mode, s.title, s.script, s.source_roots, s.output_root, s.settings from edit_batches b join edit_workbench_sessions s on s.id = b.session_id where b.id = $1', [batchId])).rows[0] as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'EDIT_BATCH_NOT_FOUND', message: '剪辑记录不存在。', details: [] } });
    const settings = row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings) ? row.settings as Record<string, unknown> : {};
    const requestedItems = Array.isArray(settings.requestedItems) ? settings.requestedItems : [];
    const sourceRoots = Array.isArray(row.source_roots)
      ? row.source_roots.map((item) => {
        if (typeof item !== 'object' || !item || !('path' in item)) return '';
        return String((item as { path?: unknown }).path || '');
      }).filter(Boolean)
      : [];
    return { id: batchId, mode: String(row.mode), title: String(row.title), script: row.script ? String(row.script) : '', sourceRoots, outputRoot: row.output_root ? String(row.output_root) : '', settings: { minClipDurationMs: Number(settings.minClipDurationMs || 2_000), maxClipDurationMs: Number(settings.maxClipDurationMs || 5_000), seed: Number(settings.seed || 1), variants: Number(settings.variants || 1), fps: Number(settings.fps || 30), preferUnusedMedia: settings.preferUnusedMedia !== false, usePexels: settings.usePexels === true, templateId: typeof settings.templateId === 'string' ? settings.templateId : '' }, items: requestedItems };
  });

  app.get('/api/v1/edit/batches/:batchId/items/:itemId/output', async (request, reply) => {
    const { batchId, itemId } = request.params as { batchId: string; itemId: string };
    const row = (await dependencies.db.query('select i.output_path, s.output_root from edit_batch_items i join edit_batches b on b.id = i.batch_id join edit_workbench_sessions s on s.id = b.session_id where i.id = $1 and i.batch_id = $2 and i.state = \'SUCCEEDED\'', [itemId, batchId])).rows[0] as { output_path?: string; output_root?: string | null } | undefined;
    if (!row?.output_path || !row.output_root) return reply.code(404).send({ error: { code: 'EDIT_OUTPUT_NOT_FOUND', message: '成片尚未导出。', details: [] } });
    try {
      const outputRoot = await authorizeOutputRoot(row.output_root);
      const target = await realpath(row.output_path);
      if (!contained(outputRoot, target)) throw new Error('EDIT_OUTPUT_ROOT_UNAUTHORIZED');
      const details = await stat(target);
      if (!details.isFile()) throw new Error('EDIT_OUTPUT_NOT_FOUND');
      reply.header('content-type', 'video/mp4'); reply.header('content-length', details.size); reply.header('accept-ranges', 'bytes');
      return reply.send(createReadStream(target));
    } catch { return reply.code(404).send({ error: { code: 'EDIT_OUTPUT_NOT_FOUND', message: '成片文件不可用。', details: [] } }); }
  });

  app.post('/api/v1/edit/batches/:batchId/retry', async (request, reply) => {
    const batchId = String((request.params as { batchId: string }).batchId);
    const client = await dependencies.db.connect();
    let rows: Record<string, unknown>[] = [];
    try {
      await client.query('begin');
      // Claim rows while holding a row lock. A second operator click sees no
      // FAILED rows until the first request either completes or releases them.
      rows = (await client.query("select * from edit_batch_items where batch_id = $1 and state = 'FAILED' order by ordinal for update skip locked", [batchId])).rows as Record<string, unknown>[];
      for (const row of rows) await client.query("update edit_batch_items set state='RUNNING',updated_at=now() where id=$1 and state='FAILED'", [row.id]);
      await client.query('commit');
    } catch (error) { await client.query('rollback').catch(() => undefined); throw error; } finally { client.release(); }
    const retried: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!row.manifest_id || !row.workspace_id) {
        if (!row.workspace_id) continue;
        const retryKey = row.prepare_job_id ? `edit-prepare:${String(row.id)}:retry:${String(row.prepare_job_id)}` : `edit-prepare:${String(row.id)}`;
        const prepareJob = await dependencies.jobs.createIdempotent({ id: `job-${randomUUID()}`, projectId: null, workspaceId: String(row.workspace_id), type: 'EDIT_PREPARE_ITEM', payload: { batchId, itemId: String(row.id), workspaceId: String(row.workspace_id) }, idempotencyKey: retryKey, maxAttempts: 3 });
        await dependencies.db.query("update edit_batch_items set prepare_job_id=$2,state='PREPARING',error=null,updated_at=now() where id=$1 and state='RUNNING'", [row.id, prepareJob.id]);
        retried.push({ id: String(row.id), state: 'PREPARING' });
        continue;
      }
      try {
        const job = await dependencies.video.createManifestRenderJobForWorkspace(String(row.workspace_id), String(row.manifest_id), renderRetryIdempotencySuffix(String(row.id), row.job_id ? String(row.job_id) : null));
        await dependencies.db.query('update edit_batch_items set job_id=$2,state=$3,error=null,updated_at=now() where id=$1 and state=$4', [row.id, job.id, 'QUEUED', 'RUNNING']);
        retried.push({ id: String(row.id), jobId: job.id, state: job.state });
      } catch (error) {
        await dependencies.db.query("update edit_batch_items set state='FAILED',error=$2,updated_at=now() where id=$1 and state='RUNNING'", [row.id, { code: 'EDIT_RETRY_FAILED', message: friendlyEditError(error) }]);
      }
    }
    return reply.code(202).send({ batchId, items: retried });
  });

  app.post('/api/v1/edit/batches/:batchId/export', async (request, reply) => {
    const batchId = String((request.params as { batchId: string }).batchId);
    const requested = z.object({ outputRoot: z.string().trim().min(1).optional() }).safeParse(request.body || {});
    if (!requested.success) return reply.code(422).send({ error: { code: 'EDIT_OUTPUT_INVALID', message: '输出目录不正确。', details: requested.error.issues } });
    const batch = (await dependencies.db.query('select b.*, s.title, s.output_root, s.settings from edit_batches b join edit_workbench_sessions s on s.id = b.session_id where b.id = $1', [batchId])).rows[0] as Record<string, unknown> | undefined;
    if (!batch) return reply.code(404).send({ error: { code: 'EDIT_BATCH_NOT_FOUND', message: '剪辑记录不存在。', details: [] } });
    let outputRoot: string;
    try { outputRoot = await authorizeOutputRoot(String(requested.data.outputRoot || batch.output_root || '')); }
    catch (error) {
      const code = error instanceof Error ? error.message : 'EDIT_OUTPUT_ROOT_INVALID';
      const message = code === 'EDIT_OUTPUT_ROOT_NOT_FOUND' ? '输出目录不存在，请先创建目录。' : code === 'EDIT_OUTPUT_ROOT_NOT_WRITABLE' ? '输出目录不可写，请检查权限。' : '输出目录未被授权，请配置允许的输出根目录。';
      return reply.code(code.includes('UNAUTHORIZED') ? 403 : 422).send({ error: { code, message, details: [] } });
    }
    const rows = (await dependencies.db.query("select * from edit_batch_items where batch_id=$1 and state='SUCCEEDED' and output_asset_id is not null order by ordinal", [batchId])).rows as Record<string, unknown>[];
    const outputs: string[] = [];
    const transaction = await dependencies.db.connect();
    try {
      await transaction.query('begin');
      // Serialize destination reservation per output root, not only per batch.
      // This closes the TOCTOU window when two batches export concurrently.
      await transaction.query('select pg_advisory_xact_lock(hashtext($1))', [`contentos:edit-export-root:${outputRoot.toLowerCase()}`]);
      for (const row of rows) {
        const asset = await dependencies.assets.getReadyWorkspaceAssetContent(String(row.workspace_id), String(row.output_asset_id));
        if (!asset) continue;
        const settings = batch.settings && typeof batch.settings === 'object' && !Array.isArray(batch.settings) ? batch.settings as Record<string, unknown> : {};
        const variantCount = Number(settings.variants || 1);
        const stem = outputFileStem(String(row.title), Number(row.source_item_ordinal || row.ordinal), Number(row.variant_index || 0), variantCount); let destination = join(outputRoot, `${stem}.mp4`); let suffix = 2;
        while (await stat(destination).then(() => true).catch(() => false) || (await transaction.query('select 1 from edit_exports where output_path=$1 and status in (\'QUEUED\',\'RUNNING\',\'SUCCEEDED\')', [destination])).rows[0]) { destination = join(outputRoot, `${stem}_${suffix}.mp4`); suffix += 1; }
        const exportId = `edit-export-${randomUUID()}`;
        const jobId = `job-${randomUUID()}`;
        const idempotencyKey = `edit-export:${row.id}:${destination}`;
        await transaction.query('insert into jobs (id,project_id,workspace_id,type,state,idempotency_key,payload,max_attempts) values ($1,null,$2,$3,$4,$5,$6,$7)', [jobId, String(row.workspace_id), 'EDIT_EXPORT', 'QUEUED', idempotencyKey, { exportId, batchId, batchItemId: String(row.id), workspaceId: String(row.workspace_id), assetId: asset.id, outputPath: destination, outputRoot }, 3]);
        await transaction.query('insert into edit_exports (id,batch_item_id,asset_id,output_path,status,job_id) values ($1,$2,$3,$4,$5,$6)', [exportId, row.id, asset.id, destination, 'QUEUED', jobId]);
        outputs.push(destination);
      }
      await transaction.query('commit');
    } catch (error) { await transaction.query('rollback').catch(() => undefined); throw error; }
    finally { transaction.release(); }
    return { batchId, outputRoot, files: outputs, status: 'QUEUED' };
  });

  app.post('/api/v1/edit/exports/:exportId/retry', async (request, reply) => {
    const exportId = String((request.params as { exportId: string }).exportId);
    const row = (await dependencies.db.query(`select e.*, i.batch_id, i.workspace_id, s.output_root
      from edit_exports e join edit_batch_items i on i.id = e.batch_item_id
      join edit_batches b on b.id = i.batch_id
      join edit_workbench_sessions s on s.id = b.session_id
      where e.id = $1`, [exportId])).rows[0] as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'EDIT_EXPORT_NOT_FOUND', message: '导出任务不存在。', details: [] } });
    if (String(row.status) !== 'FAILED') return reply.code(409).send({ error: { code: 'EDIT_EXPORT_NOT_RETRYABLE', message: '当前导出任务不需要重试。', details: [] } });
    let outputRoot: string;
    try {
      outputRoot = await authorizeOutputRoot(String(row.output_root || ''));
      const destinationParent = await realpath(dirname(String(row.output_path))).catch(() => null);
      if (!destinationParent || !contained(outputRoot, destinationParent)) throw new Error('EDIT_OUTPUT_ROOT_UNAUTHORIZED');
      if (await stat(String(row.output_path)).then(() => true).catch(() => false)) throw new Error('EDIT_EXPORT_DESTINATION_EXISTS');
    } catch (error) {
      const code = error instanceof Error ? error.message : 'EDIT_EXPORT_RETRY_FAILED';
      const message = code === 'EDIT_EXPORT_DESTINATION_EXISTS' ? '目标文件已存在，请重新发起导出以生成新文件名。' : '导出目录未被授权或不可用。';
      return reply.code(code === 'EDIT_EXPORT_DESTINATION_EXISTS' ? 409 : 422).send({ error: { code, message, details: [] } });
    }
    const transaction = await dependencies.db.connect();
    try {
      await transaction.query('begin');
      const locked = (await transaction.query('select status, batch_item_id, asset_id, output_path from edit_exports where id=$1 for update', [exportId])).rows[0] as { status: string; batch_item_id: string; asset_id: string; output_path: string } | undefined;
      if (!locked || locked.status !== 'FAILED') { await transaction.query('rollback'); return reply.code(409).send({ error: { code: 'EDIT_EXPORT_NOT_RETRYABLE', message: '当前导出任务不需要重试。', details: [] } }); }
      await transaction.query('select pg_advisory_xact_lock(hashtext($1))', [`contentos:edit-export-root:${outputRoot.toLowerCase()}`]);
      const jobId = `job-${randomUUID()}`;
      const idempotencyKey = `edit-export-retry:${exportId}:${jobId}`;
      await transaction.query('insert into jobs (id,project_id,workspace_id,type,state,idempotency_key,payload,max_attempts) values ($1,null,$2,$3,$4,$5,$6,$7)', [jobId, String(row.workspace_id), 'EDIT_EXPORT', 'QUEUED', idempotencyKey, { exportId, batchId: String(row.batch_id), batchItemId: String(locked.batch_item_id), workspaceId: String(row.workspace_id), assetId: String(locked.asset_id), outputPath: String(locked.output_path), outputRoot }, 3]);
      await transaction.query("update edit_exports set status='QUEUED',error=null,finished_at=null,job_id=$2 where id=$1", [exportId, jobId]);
      await transaction.query('commit');
      return reply.code(202).send({ exportId, jobId, status: 'QUEUED' });
    } catch (error) { await transaction.query('rollback').catch(() => undefined); throw error; }
    finally { transaction.release(); }
  });
}
