import { randomUUID } from 'node:crypto';
import { access, constants, copyFile, realpath, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildRandomSentenceMontageManifest, buildScriptMontageManifest, segmentScriptSentences } from '../../../packages/modules/video/src/index.js';
import type { VideoAdjustmentService, VideoService } from '../../../packages/modules/video/src/index.js';
import type { JobService } from '../../../packages/modules/job/src/index.js';
import type { AssetCatalogService, LocalMediaSourceService } from '../../../packages/modules/asset/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';

const itemInput = z.object({ title: z.string().trim().max(200).optional(), script: z.string().trim().min(1).max(100_000), voiceAssetId: z.string().trim().min(1).optional(), voicePath: z.string().trim().min(1).optional() });
const pairInput = z.object({ textFiles: z.array(z.string().trim().min(1)).max(500), audioFiles: z.array(z.string().trim().min(1)).max(500) });
const sessionInput = z.object({ mode: z.enum(['SCRIPT', 'MIX']), title: z.string().trim().max(200).optional(), script: z.string().trim().max(100_000).optional(), voicePath: z.string().trim().min(1).optional(), items: z.array(itemInput).min(1).max(100).optional(), testOnly: z.boolean().default(false), sourceRoots: z.array(z.string().trim().min(1)).min(1).max(16), outputRoot: z.string().trim().min(1).optional(), seed: z.number().int().optional(), minClipDurationMs: z.number().int().positive().default(2_000), maxClipDurationMs: z.number().int().positive().default(5_000), preferUnusedMedia: z.boolean().default(true) }).superRefine((value, ctx) => { if (value.mode === 'SCRIPT' && !value.script?.trim() && !value.items?.[0]?.script) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['script'], message: '请输入文案。' }); if (value.mode === 'MIX' && (!value.items || value.items.length === 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '请至少添加一条文案。' }); if (value.maxClipDurationMs < value.minClipDurationMs) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxClipDurationMs'], message: '最长镜头不能短于最短镜头。' }); });

export interface EditingWorkbenchRouteDependencies { db: Pool; localMedia: LocalMediaSourceService; quickEdit: VideoAdjustmentService; video: VideoService; jobs: JobService; assets: AssetCatalogService; assetService: import('../../../packages/modules/asset/src/index.js').AssetService; storage: LocalStorageProvider; }

function allowedOutputRoots(): string[] { return (process.env.CONTENTOS_OUTPUT_ROOTS || '').split(';').map((value) => value.trim()).filter(Boolean).map((value) => resolve(value)); }
function contained(root: string, candidate: string): boolean { const normalized = root.endsWith(sep) ? root : `${root}${sep}`; return candidate.toLowerCase() === root.toLowerCase() || candidate.toLowerCase().startsWith(normalized.toLowerCase()); }
async function authorizeOutputRoot(input: string): Promise<string> {
  if (!input || input.includes('\0')) throw new Error('EDIT_OUTPUT_ROOT_INVALID');
  const root = resolve(input);
  const allowed = allowedOutputRoots();
  if (allowed.length === 0 || !allowed.some((candidate) => contained(candidate, root))) throw new Error('EDIT_OUTPUT_ROOT_UNAUTHORIZED');
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
export function pairByBasename(textFiles: string[], audioFiles: string[]): Array<{ ordinal: number; basename: string; textFile: string | null; audioFile: string | null; status: 'READY' | 'MISSING_AUDIO' | 'MISSING_TEXT' }> {
  const texts = new Map(textFiles.filter((file) => /\.(txt|md)$/iu.test(file)).map((file) => [file.replace(/\.[^.]+$/u, '').toLowerCase(), file]));
  const audios = new Map(audioFiles.filter((file) => /\.(mp3|wav|m4a|aac)$/iu.test(file)).map((file) => [file.replace(/\.[^.]+$/u, '').toLowerCase(), file]));
  return [...new Set([...texts.keys(), ...audios.keys()])].sort().map((key, index) => ({ ordinal: index + 1, basename: key, textFile: texts.get(key) || null, audioFile: audios.get(key) || null, status: texts.has(key) && audios.has(key) ? 'READY' : texts.has(key) ? 'MISSING_AUDIO' : 'MISSING_TEXT' }));
}
function itemTitle(item: { title?: string | undefined; script: string }, ordinal: number): string { return cleanFilePart(item.title?.trim() || item.script.split(/[\r\n。！？!?]/u)[0]?.trim() || `任务${ordinal}`); }
function publicItem(row: Record<string, unknown>, job?: Record<string, unknown> | null): Record<string, unknown> {
  const state = job?.state || row.state || 'QUEUED';
  return { id: String(row.id), ordinal: Number(row.ordinal), title: String(row.title), script: String(row.script), state, jobId: row.job_id ? String(row.job_id) : undefined, outputAssetId: row.output_asset_id ? String(row.output_asset_id) : undefined, outputPath: row.output_path ? String(row.output_path) : undefined, error: row.error || job?.error || undefined };
}

async function assertSafeSourceRoot(sourceRoot: string): Promise<void> {
  const configured = (process.env.CONTENTOS_LOCAL_MEDIA_ROOTS || '').split(';').map((value) => value.trim()).filter(Boolean).map((value) => resolve(value));
  if (configured.length === 0) return;
  const candidate = await realpath(resolve(sourceRoot)).catch(() => null);
  if (!candidate) return;
  const authorized = await Promise.all(configured.map(async (root) => { try { return await realpath(root); } catch { return null; } }));
  if (!authorized.some((root) => root && contained(root, candidate))) throw new Error('LOCAL_MEDIA_ROOT_UNAUTHORIZED');
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
    return { items: pairByBasename(parsed.data.textFiles, parsed.data.audioFiles) };
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
      const requestedItems = input.mode === 'SCRIPT' ? [{ script: input.script?.trim() || input.items?.[0]?.script || '', title, voiceAssetId: input.items?.[0]?.voiceAssetId, voicePath: input.voicePath || input.items?.[0]?.voicePath }] : (input.items || []);
      const items = input.testOnly ? requestedItems.slice(0, 1) : requestedItems;
      await dependencies.db.query('insert into edit_workbench_sessions (id, mode, title, script, source_roots, output_root, settings) values ($1,$2,$3,$4,$5,$6,$7)', [sessionId, input.mode, title, input.script || null, JSON.stringify(scanned.scans.map(({ files: _files, ...scan }) => scan)), outputRoot, { seed: input.seed ?? 1, minClipDurationMs: input.minClipDurationMs, maxClipDurationMs: input.maxClipDurationMs, preferUnusedMedia: input.preferUnusedMedia, testOnly: input.testOnly, sourceWorkspaceId }]);
      await dependencies.db.query('insert into edit_batches (id, session_id, mode, status, total_count) values ($1,$2,$3,$4,$5)', [batchId, sessionId, input.mode, 'RUNNING', items.length]);
      const resultItems: Record<string, unknown>[] = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!; const workspaceId = `workspace-edit-${randomUUID()}`; const itemId = `edit-item-${randomUUID()}`;
        await dependencies.db.query("insert into video_workspaces (id, type, project_id) values ($1, 'STANDALONE', null)", [workspaceId]);
        let voiceAssetId = item.voiceAssetId;
        if (!voiceAssetId && item.voicePath) {
          const voiceFile = resolve(item.voicePath); const authorizedVoiceRoot = dependencies.localMedia.authorizeRoot(dirname(voiceFile)); await access(voiceFile);
          if (!authorizedVoiceRoot.root) throw new Error('EDIT_VOICE_PATH_UNAUTHORIZED');
          const imported = await dependencies.assetService.importFile({ workspaceId, sourcePath: voiceFile, kind: 'AUDIO', role: 'VOICE' }); voiceAssetId = imported.id;
        }
        const sentences = segmentScriptSentences(item.script);
        let planned;
        if (input.mode === 'MIX') planned = buildRandomSentenceMontageManifest({ workspaceId, sentences, assets: scanned.assets, seed: (input.seed ?? 1) + index, minClipDurationMs: input.minClipDurationMs, maxClipDurationMs: input.maxClipDurationMs, preferUnusedMedia: input.preferUnusedMedia, ...(voiceAssetId ? { voiceAssetId } : {}) });
        else {
          try { planned = buildScriptMontageManifest({ workspaceId, script: item.script, sentences, assets: scanned.assets, seed: (input.seed ?? 1) + index, minClipDurationMs: input.minClipDurationMs, maxClipDurationMs: input.maxClipDurationMs, preferUnusedMedia: input.preferUnusedMedia, ...(voiceAssetId ? { voiceAssetId } : {}) }); }
          catch (error) {
            if (scanned.assets.length !== 1 || !(error instanceof Error) || !error.message.includes('Adjacent duplicate clips')) throw error;
            planned = buildRandomSentenceMontageManifest({ workspaceId, sentences, assets: scanned.assets, seed: (input.seed ?? 1) + index, minClipDurationMs: input.minClipDurationMs, maxClipDurationMs: input.maxClipDurationMs, preferUnusedMedia: input.preferUnusedMedia, ...(voiceAssetId ? { voiceAssetId } : {}) });
          }
        }
        const manifest = await dependencies.quickEdit.createPlannedManifest({ workspaceId, manifest: planned.manifest, createdBy: 'operator' });
        const job = await dependencies.video.createManifestRenderJobForWorkspace(workspaceId, manifest.id);
        await dependencies.db.query('insert into edit_batch_items (id,batch_id,ordinal,title,script,voice_asset_id,workspace_id,manifest_id,job_id,state) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [itemId, batchId, index + 1, itemTitle(item, index + 1), item.script, voiceAssetId || null, workspaceId, manifest.id, job.id, 'QUEUED']);
        resultItems.push({ id: itemId, ordinal: index + 1, title: itemTitle(item, index + 1), script: item.script, state: job.state, jobId: job.id });
      }
      return reply.code(201).send({ id: sessionId, batchId, mode: input.mode, title, testOnly: input.testOnly, sources: scanned.scans.map(({ files: _files, ...scan }) => scan), outputRoot, items: resultItems });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'EDIT_SESSION_CREATE_FAILED';
      const message = code === 'EDIT_OUTPUT_ROOT_UNAUTHORIZED' ? '输出目录未被授权，请配置允许的输出根目录。' : code === 'EDIT_OUTPUT_ROOT_NOT_FOUND' ? '输出目录不存在，请先创建目录。' : code === 'EDIT_OUTPUT_ROOT_NOT_WRITABLE' ? '输出目录不可写，请检查权限。' : code === 'LOCAL_MEDIA_ROOT_UNAUTHORIZED' ? '素材目录未被授权，请检查本地素材根目录配置。' : code === 'EDIT_NO_VIDEO_ASSETS' ? '没有找到可用于剪辑的视频素材。' : '剪辑任务创建失败，请检查路径和素材。';
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
    const batch = (await dependencies.db.query('select b.*, s.title, s.mode, s.output_root from edit_batches b join edit_workbench_sessions s on s.id = b.session_id where b.id = $1', [batchId])).rows[0] as Record<string, unknown> | undefined;
    if (!batch) return reply.code(404).send({ error: { code: 'EDIT_BATCH_NOT_FOUND', message: '剪辑记录不存在。', details: [] } });
    const rows = (await dependencies.db.query('select * from edit_batch_items where batch_id = $1 order by ordinal', [batchId])).rows as Record<string, unknown>[];
    const items = await Promise.all(rows.map(async (row) => {
      const job = row.job_id ? await dependencies.jobs.get(String(row.job_id)) : null;
      const result = job?.result && typeof job.result === 'object' ? job.result as { outputAssetId?: string } : {};
      const state = job?.state || row.state || 'QUEUED';
      if (state !== row.state || (result.outputAssetId && result.outputAssetId !== row.output_asset_id)) await dependencies.db.query('update edit_batch_items set state=$2, output_asset_id=coalesce($3, output_asset_id), error=$4, updated_at=now() where id=$1', [row.id, state, result.outputAssetId || null, job?.error || null]);
      return publicItem({ ...row, state, ...(result.outputAssetId ? { output_asset_id: result.outputAssetId } : {}) }, job as unknown as Record<string, unknown> | null);
    }));
    const states = items.map((item) => String(item.state)); const succeeded = states.filter((state) => state === 'SUCCEEDED').length; const failed = states.filter((state) => state === 'FAILED').length;
    const status = failed > 0 && succeeded > 0 ? 'PARTIAL' : failed === states.length ? 'FAILED' : succeeded === states.length ? 'SUCCEEDED' : 'RUNNING';
    await dependencies.db.query('update edit_batches set status=$2, succeeded_count=$3, failed_count=$4, updated_at=now() where id=$1', [batchId, status, succeeded, failed]);
    return { id: batchId, title: String(batch.title), mode: String(batch.mode), status, totalCount: states.length, succeededCount: succeeded, failedCount: failed, outputRoot: batch.output_root || null, items };
  });

  app.get('/api/v1/edit/history', async (_request, reply) => {
    const rows = await dependencies.db.query('select b.id, b.mode, b.status, b.total_count, b.succeeded_count, b.failed_count, b.created_at, s.title, s.output_root from edit_batches b join edit_workbench_sessions s on s.id = b.session_id order by b.created_at desc limit 50');
    return { items: rows.rows.map((row) => ({ id: String(row.id), title: String(row.title), mode: String(row.mode), status: String(row.status), totalCount: Number(row.total_count), succeededCount: Number(row.succeeded_count), failedCount: Number(row.failed_count), createdAt: new Date(String(row.created_at)).toISOString(), outputRoot: row.output_root || null })) };
  });

  app.post('/api/v1/edit/batches/:batchId/retry', async (request, reply) => {
    const batchId = String((request.params as { batchId: string }).batchId);
    const rows = (await dependencies.db.query("select * from edit_batch_items where batch_id = $1 and state = 'FAILED' order by ordinal", [batchId])).rows as Record<string, unknown>[];
    const retried: Record<string, unknown>[] = [];
    for (const row of rows) {
      const job = await dependencies.video.createManifestRenderJobForWorkspace(String(row.workspace_id), String(row.manifest_id), `retry-${Date.now()}-${randomUUID()}`);
      await dependencies.db.query('update edit_batch_items set job_id=$2,state=$3,error=null,updated_at=now() where id=$1', [row.id, job.id, 'QUEUED']);
      retried.push({ id: String(row.id), jobId: job.id, state: job.state });
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
      const stem = outputFileStem(String(row.title), Number(row.ordinal)); let destination = join(outputRoot, `${stem}.mp4`); let suffix = 2;
      while (true) { try { await access(destination); destination = join(outputRoot, `${stem}_${suffix}.mp4`); suffix += 1; } catch { break; } }
      const temp = `${destination}.${randomUUID()}.part`; await copyFile(dependencies.storage.objectPath(asset.storageKey), temp); await rename(temp, destination);
      await dependencies.db.query('insert into edit_exports (id,batch_item_id,asset_id,output_path,status,finished_at) values ($1,$2,$3,$4,$5,now()) on conflict (batch_item_id,output_path) do update set status=excluded.status, finished_at=excluded.finished_at', [`edit-export-${randomUUID()}`, row.id, asset.id, destination, 'SUCCEEDED']);
      await dependencies.db.query('update edit_batch_items set output_path=$2,updated_at=now() where id=$1', [row.id, destination]); outputs.push(destination);
    }
    return { batchId, outputRoot, files: outputs };
  });
}
