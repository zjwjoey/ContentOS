import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants, copyFile, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { assembleBrandedTimeline, buildRandomSentenceMontageManifest, buildScriptMontageManifest, segmentScriptSentences } from '../../../packages/modules/video/src/index.js';
import type { VideoAdjustmentService, VideoEditPresetService, VideoService } from '../../../packages/modules/video/src/index.js';
import type { JobService } from '../../../packages/modules/job/src/index.js';
import type { AssetCatalogService, LocalMediaSourceService } from '../../../packages/modules/asset/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';

const itemInput = z.object({ title: z.string().trim().max(200).optional(), script: z.string().trim().min(1).max(100_000), voiceAssetId: z.string().trim().min(1).optional(), voicePath: z.string().trim().min(1).optional() });
const pairInput = z.object({ textFiles: z.array(z.string().trim().min(1)).max(500), audioFiles: z.array(z.string().trim().min(1)).max(500), includeContent: z.boolean().default(false) });
const sessionInput = z.object({ mode: z.enum(['SCRIPT', 'MIX']), title: z.string().trim().max(200).optional(), script: z.string().trim().max(100_000).optional(), voicePath: z.string().trim().min(1).optional(), items: z.array(itemInput).min(1).max(100).optional(), testOnly: z.boolean().default(false), sourceRoots: z.array(z.string().trim().min(1)).min(1).max(16), outputRoot: z.string().trim().min(1).optional(), templateId: z.string().trim().min(1).optional(), seed: z.number().int().optional(), variants: z.number().int().refine((value) => value === 1 || value === 3 || value === 5, '版本数只能是 1、3 或 5。').default(1), fps: z.number().int().min(1).max(120).default(30), minClipDurationMs: z.number().int().positive().default(2_000), maxClipDurationMs: z.number().int().positive().default(5_000), preferUnusedMedia: z.boolean().default(true) }).superRefine((value, ctx) => { if (value.mode === 'SCRIPT' && !value.script?.trim() && !value.items?.[0]?.script) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['script'], message: '请输入文案。' }); if (value.mode === 'MIX' && (!value.items || value.items.length === 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '请至少添加一条文案。' }); if (!value.outputRoot) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputRoot'], message: '请填写输出文件夹。' }); if (value.maxClipDurationMs < value.minClipDurationMs) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxClipDurationMs'], message: '最长镜头不能短于最短镜头。' }); });

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
export function outputFileStem(title: string, ordinal: number): string { return `${String(ordinal).padStart(3, '0')}_${cleanFilePart(title)}`; }
export async function promoteStagedUpload(stagedPath: string, destination: string): Promise<void> {
  const sameVolumePart = `${destination}.${randomUUID()}.part`;
  try {
    await copyFile(stagedPath, sameVolumePart);
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
  const state = job?.state || row.state || 'QUEUED';
  return { id: String(row.id), ordinal: Number(row.ordinal), title: String(row.title), script: String(row.script), state, jobId: row.job_id ? String(row.job_id) : undefined, outputAssetId: row.output_asset_id ? String(row.output_asset_id) : undefined, outputPath: row.output_path ? String(row.output_path) : undefined, error: row.error || job?.error || undefined };
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
      const sessionId = `edit-session-${randomUUID()}`;
      const sourceWorkspaceId = `workspace-edit-source-${randomUUID()}`;
      await dependencies.db.query("insert into video_workspaces (id, type, project_id) values ($1, 'STANDALONE', null)", [sourceWorkspaceId]);
      const scanned = await scanRoots(dependencies.localMedia, input.sourceRoots, sourceWorkspaceId);
      if (scanned.assets.length === 0) throw new Error('EDIT_NO_VIDEO_ASSETS');
      const batchId = `edit-batch-${randomUUID()}`;
      const title = cleanFilePart(input.title || (input.mode === 'SCRIPT' ? '脚本剪辑' : '批量混剪'));
      const defaultPreset = input.templateId ? await dependencies.presets?.get(input.templateId) : await dependencies.presets?.getDefault() || null;
      if (input.templateId && !defaultPreset) throw new Error('EDIT_TEMPLATE_NOT_FOUND');
      const requestedItems = input.mode === 'SCRIPT' ? [{ script: input.script?.trim() || input.items?.[0]?.script || '', title, voiceAssetId: input.items?.[0]?.voiceAssetId, voicePath: input.voicePath || input.items?.[0]?.voicePath }] : (input.items || []);
      const variantLabels = ['A', 'B', 'C', 'D', 'E'];
      const expandedItems = requestedItems.flatMap((item) => Array.from({ length: input.variants }, (_, variantIndex) => ({ ...item, title: input.variants > 1 ? `${item.title?.trim() || title}_${variantLabels[variantIndex]}` : item.title, variantIndex })));
      const items = input.testOnly ? expandedItems.slice(0, 1) : expandedItems;
      const durableItems = items.map((item, index) => ({ item, index, itemId: `edit-item-${randomUUID()}`, workspaceId: `workspace-edit-${randomUUID()}`, titleForItem: itemTitle(item, index + 1) }));
      const transaction = await dependencies.db.connect();
      try {
        await transaction.query('begin');
        await transaction.query('insert into edit_workbench_sessions (id, mode, title, script, source_roots, output_root, settings) values ($1,$2,$3,$4,$5,$6,$7)', [sessionId, input.mode, title, input.script || null, JSON.stringify(scanned.scans.map(({ files: _files, ...scan }) => scan)), outputRoot, { seed: input.seed ?? 1, variants: input.variants, fps: input.fps, minClipDurationMs: input.minClipDurationMs, maxClipDurationMs: input.maxClipDurationMs, preferUnusedMedia: input.preferUnusedMedia, testOnly: input.testOnly, sourceWorkspaceId, requestedItems, ...(input.templateId ? { templateId: input.templateId } : {}) }]);
        await transaction.query('insert into edit_batches (id, session_id, mode, status, total_count) values ($1,$2,$3,$4,$5)', [batchId, sessionId, input.mode, 'RUNNING', durableItems.length]);
        for (const durable of durableItems) {
          await transaction.query("insert into video_workspaces (id, type, project_id) values ($1, 'STANDALONE', null)", [durable.workspaceId]);
          await transaction.query('insert into edit_batch_items (id,batch_id,ordinal,title,script,workspace_id,state) values ($1,$2,$3,$4,$5,$6,$7)', [durable.itemId, batchId, durable.index + 1, durable.titleForItem, durable.item.script, durable.workspaceId, 'QUEUED']);
        }
        await transaction.query('commit');
      } catch (error) {
        await transaction.query('rollback').catch(() => undefined);
        throw error;
      } finally { transaction.release(); }
      const resultItems: Record<string, unknown>[] = [];
      for (const durable of durableItems) {
        const { item, index, itemId, workspaceId, titleForItem } = durable;
        try {
          const stableSeed = (input.seed ?? 1) + ((index + 1) * 100) + Number(item.variantIndex || 0);
          let voiceAssetId = item.voiceAssetId;
          if (!voiceAssetId && item.voicePath) {
            const voiceFile = resolve(item.voicePath);
            await assertSafeSourceFile(voiceFile);
            const imported = await dependencies.assetService.importFile({ workspaceId, sourcePath: voiceFile, kind: 'AUDIO', role: 'VOICE' }); voiceAssetId = imported.id;
          }
          const sentences = segmentScriptSentences(item.script);
          let planned;
          if (input.mode === 'MIX') planned = buildRandomSentenceMontageManifest({ workspaceId, sentences, assets: scanned.assets, seed: stableSeed, minClipDurationMs: input.minClipDurationMs, maxClipDurationMs: input.maxClipDurationMs, preferUnusedMedia: input.preferUnusedMedia, ...(voiceAssetId ? { voiceAssetId } : {}) });
          else {
            try { planned = buildScriptMontageManifest({ workspaceId, script: item.script, sentences, assets: scanned.assets, seed: stableSeed, minClipDurationMs: input.minClipDurationMs, maxClipDurationMs: input.maxClipDurationMs, preferUnusedMedia: input.preferUnusedMedia, ...(voiceAssetId ? { voiceAssetId } : {}) }); }
            catch (error) {
              if (scanned.assets.length !== 1 || !(error instanceof Error) || !error.message.includes('Adjacent duplicate clips')) throw error;
              planned = buildRandomSentenceMontageManifest({ workspaceId, sentences, assets: scanned.assets, seed: stableSeed, minClipDurationMs: input.minClipDurationMs, maxClipDurationMs: input.maxClipDurationMs, preferUnusedMedia: input.preferUnusedMedia, ...(voiceAssetId ? { voiceAssetId } : {}) });
            }
          }
          planned.manifest.canvas.fps = input.fps;
          if (defaultPreset?.introAssetId || defaultPreset?.outroAssetId) {
            const branding = { ...(defaultPreset.introAssetId ? { intro: await dependencies.assets.getReadyGlobalVideoAssetContent(defaultPreset.introAssetId).then(async (asset) => { if (!asset) throw new Error('VIDEO_BRANDING_ASSET_INVALID'); await dependencies.assets.attachToWorkspace(workspaceId, asset.id, 'SOURCE'); return { id: asset.id, storageKey: asset.storageKey, sourcePath: dependencies.storage.objectPath(asset.storageKey), durationMs: Number(asset.metadata.durationMs || 0), role: 'INTRO' as const }; }) } : {}), ...(defaultPreset.outroAssetId ? { outro: await dependencies.assets.getReadyGlobalVideoAssetContent(defaultPreset.outroAssetId).then(async (asset) => { if (!asset) throw new Error('VIDEO_BRANDING_ASSET_INVALID'); await dependencies.assets.attachToWorkspace(workspaceId, asset.id, 'SOURCE'); return { id: asset.id, storageKey: asset.storageKey, sourcePath: dependencies.storage.objectPath(asset.storageKey), durationMs: Number(asset.metadata.durationMs || 0), role: 'OUTRO' as const }; }) } : {}) };
            planned.manifest = assembleBrandedTimeline(planned.manifest, branding);
          }
          const manifest = await dependencies.quickEdit.createPlannedManifest({ workspaceId, manifest: planned.manifest, createdBy: 'operator' });
          const job = await dependencies.video.createManifestRenderJobForWorkspace(workspaceId, manifest.id);
          await dependencies.db.query('update edit_batch_items set voice_asset_id=$2,manifest_id=$3,job_id=$4,state=$5,error=null,updated_at=now() where id=$1', [itemId, voiceAssetId || null, manifest.id, job.id, 'QUEUED']);
          resultItems.push({ id: itemId, ordinal: index + 1, title: titleForItem, script: item.script, state: job.state, jobId: job.id });
        } catch (error) {
          const failure = { code: error instanceof Error ? error.message : 'EDIT_ITEM_PREPARE_FAILED', message: friendlyEditError(error) };
          await dependencies.db.query('update edit_batch_items set state=$2,error=$3,updated_at=now() where id=$1', [itemId, 'FAILED', failure]);
          resultItems.push({ id: itemId, ordinal: index + 1, title: titleForItem, script: item.script, state: 'FAILED', error: failure });
        }
      }
      const failedCount = resultItems.filter((item) => item.state === 'FAILED').length;
      await dependencies.db.query('update edit_batches set status=$2,succeeded_count=0,failed_count=$3,updated_at=now() where id=$1', [batchId, failedCount === 0 ? 'RUNNING' : 'PARTIAL', failedCount]);
      return reply.code(201).send({ id: sessionId, batchId, mode: input.mode, title, testOnly: input.testOnly, variants: input.variants, sources: scanned.scans.map(({ files: _files, ...scan }) => scan), outputRoot, items: resultItems });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'EDIT_SESSION_CREATE_FAILED';
      const message = code === 'EDIT_OUTPUT_ROOT_UNAUTHORIZED' ? '输出目录未被授权，请配置允许的输出根目录。' : code === 'EDIT_OUTPUT_ROOT_NOT_FOUND' ? '输出目录不存在，请先创建目录。' : code === 'EDIT_OUTPUT_ROOT_NOT_WRITABLE' ? '输出目录不可写，请检查权限。' : code === 'LOCAL_MEDIA_ROOT_UNAUTHORIZED' ? '素材目录未被授权，请检查本地素材根目录配置。' : code === 'EDIT_NO_VIDEO_ASSETS' ? '没有找到可用于剪辑的视频素材。' : code === 'EDIT_TEMPLATE_NOT_FOUND' ? '剪辑模板不存在，请重新选择。' : '剪辑任务创建失败，请检查路径和素材。';
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
    const batch = (await dependencies.db.query('select b.*, s.title, s.mode, s.output_root from edit_batches b join edit_workbench_sessions s on s.id = b.session_id where b.id = $1', [batchId])).rows[0] as Record<string, unknown> | undefined;
    if (!batch) return reply.code(404).send({ error: { code: 'EDIT_BATCH_NOT_FOUND', message: '剪辑记录不存在。', details: [] } });
    const offset = (pageQuery.data.page - 1) * pageQuery.data.pageSize;
    const summary = (await dependencies.db.query("select count(*)::int as total, count(*) filter (where coalesce(j.state, i.state) = 'SUCCEEDED')::int as succeeded, count(*) filter (where coalesce(j.state, i.state) = 'FAILED')::int as failed from edit_batch_items i left join jobs j on j.id = i.job_id where i.batch_id = $1", [batchId])).rows[0] as { total?: number; succeeded?: number; failed?: number } | undefined;
    const rows = (await dependencies.db.query('select i.*, j.state as job_state, j.result as job_result, j.error as job_error from edit_batch_items i left join jobs j on j.id = i.job_id where i.batch_id = $1 order by i.ordinal limit $2 offset $3', [batchId, pageQuery.data.pageSize, offset])).rows as Record<string, unknown>[];
    const items = await Promise.all(rows.map(async (row) => {
      const job = row.job_id ? { state: row.job_state, result: row.job_result, error: row.job_error } : null;
      const result = job?.result && typeof job.result === 'object' ? job.result as { outputAssetId?: string } : {};
      const state = job?.state || row.state || 'QUEUED';
      if (state !== row.state || (result.outputAssetId && result.outputAssetId !== row.output_asset_id)) await dependencies.db.query('update edit_batch_items set state=$2, output_asset_id=coalesce($3, output_asset_id), error=$4, updated_at=now() where id=$1', [row.id, state, result.outputAssetId || null, job?.error || null]);
      return publicItem({ ...row, state, ...(result.outputAssetId ? { output_asset_id: result.outputAssetId } : {}) }, job as unknown as Record<string, unknown> | null);
    }));
    const succeeded = Number(summary?.succeeded || 0); const failed = Number(summary?.failed || 0); const total = Number(summary?.total || batch.total_count || 0);
    const status = failed > 0 && succeeded > 0 ? 'PARTIAL' : total > 0 && failed === total ? 'FAILED' : total > 0 && succeeded === total ? 'SUCCEEDED' : 'RUNNING';
    await dependencies.db.query('update edit_batches set status=$2, succeeded_count=$3, failed_count=$4, updated_at=now() where id=$1', [batchId, status, succeeded, failed]);
    return { id: batchId, title: String(batch.title), mode: String(batch.mode), status, totalCount: Number(batch.total_count), succeededCount: succeeded, failedCount: failed, page: pageQuery.data.page, pageSize: pageQuery.data.pageSize, items };
  });

  app.get('/api/v1/edit/history', async (request, reply) => {
    const parsed = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'EDIT_HISTORY_INVALID', message: '历史记录分页参数不正确。', details: parsed.error.issues } });
    const offset = (parsed.data.page - 1) * parsed.data.pageSize;
    const rows = await dependencies.db.query('select b.id, b.mode, b.status, b.total_count, b.succeeded_count, b.failed_count, b.created_at, s.title, s.output_root from edit_batches b join edit_workbench_sessions s on s.id = b.session_id order by b.created_at desc limit $1 offset $2', [parsed.data.pageSize, offset]);
    return { page: parsed.data.page, pageSize: parsed.data.pageSize, items: rows.rows.map((row) => ({ id: String(row.id), title: String(row.title), mode: String(row.mode), status: String(row.status), totalCount: Number(row.total_count), succeededCount: Number(row.succeeded_count), failedCount: Number(row.failed_count), createdAt: new Date(String(row.created_at)).toISOString(), outputRoot: row.output_root || null })) };
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
    return { id: batchId, mode: String(row.mode), title: String(row.title), script: row.script ? String(row.script) : '', sourceRoots, outputRoot: row.output_root ? String(row.output_root) : '', settings: { minClipDurationMs: Number(settings.minClipDurationMs || 2_000), maxClipDurationMs: Number(settings.maxClipDurationMs || 5_000), seed: Number(settings.seed || 1), variants: Number(settings.variants || 1), fps: Number(settings.fps || 30), preferUnusedMedia: settings.preferUnusedMedia !== false, templateId: typeof settings.templateId === 'string' ? settings.templateId : '' }, items: requestedItems };
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
        await dependencies.db.query("update edit_batch_items set state='FAILED',updated_at=now() where id=$1 and state='RUNNING'", [row.id]);
        continue;
      }
      try {
        const job = await dependencies.video.createManifestRenderJobForWorkspace(String(row.workspace_id), String(row.manifest_id), `edit-retry-${String(row.id)}`);
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
    const batch = (await dependencies.db.query('select b.*, s.title, s.output_root from edit_batches b join edit_workbench_sessions s on s.id = b.session_id where b.id = $1', [batchId])).rows[0] as Record<string, unknown> | undefined;
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
    for (const row of rows) {
      const asset = await dependencies.assets.getReadyWorkspaceAssetContent(String(row.workspace_id), String(row.output_asset_id));
      if (!asset) continue;
      const stem = outputFileStem(String(row.title), Number(row.ordinal)); let destination = join(outputRoot, `${stem}.mp4`); let suffix = 2; let lockPath = `${destination}.lock`;
      while (true) {
        if (await stat(destination).then(() => true).catch(() => false)) { destination = join(outputRoot, `${stem}_${suffix}.mp4`); lockPath = `${destination}.lock`; suffix += 1; continue; }
        try { await mkdir(lockPath); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; destination = join(outputRoot, `${stem}_${suffix}.mp4`); lockPath = `${destination}.lock`; suffix += 1; }
      }
      const exportId = `edit-export-${randomUUID()}`;
      const temp = `${destination}.${randomUUID()}.part`;
      await dependencies.db.query('insert into edit_exports (id,batch_item_id,asset_id,output_path,status) values ($1,$2,$3,$4,$5)', [exportId, row.id, asset.id, destination, 'RUNNING']);
      try {
        await copyFile(dependencies.storage.objectPath(asset.storageKey), temp);
        await rename(temp, destination);
        await dependencies.db.query('update edit_exports set status=$2,finished_at=now(),error=null where id=$1', [exportId, 'SUCCEEDED']);
        await dependencies.db.query('update edit_batch_items set output_path=$2,updated_at=now() where id=$1', [row.id, destination]); outputs.push(destination);
      } catch (error) {
        await dependencies.db.query('update edit_exports set status=$2,error=$3,finished_at=now() where id=$1', [exportId, 'FAILED', { code: 'EDIT_EXPORT_FAILED', message: friendlyEditError(error) }]).catch(() => undefined);
        throw error;
      } finally {
        await rm(temp, { force: true }).catch(() => undefined);
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    return { batchId, outputRoot, files: outputs };
  });
}
