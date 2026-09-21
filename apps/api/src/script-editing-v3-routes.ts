import { createHash, randomUUID } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createExternalVideoProvider, ensureStandaloneWorkspace, HybridMediaService, JianyingRuntimeLocator, ScriptEditingV3Service, type VideoService } from '../../../packages/modules/video/src/index.js';
import type { JobService } from '../../../packages/modules/job/src/index.js';
import { AssetCatalogService, type AssetService, type LocalMediaSourceService } from '../../../packages/modules/asset/src/index.js';
import type { LocalPathAccessService } from '../../../packages/modules/local-path/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { prepareVoiceTiming } from '../../../packages/modules/video/src/index.js';

const scanInput = z.object({ workspaceId: z.string().trim().min(1), sourceRoot: z.string().trim().min(1), recursive: z.boolean().default(true) });
const snapshotInput = z.object({ workspaceId: z.string().trim().min(1), sourceRootIds: z.array(z.string().trim().min(1)).default([]), sourceFiles: z.array(z.string().trim().min(1)).max(100).default([]), sourceKind: z.enum(['MANUAL', 'JIANYING_DRAFT', 'MIXED']).default('MANUAL') });
const sessionInput = z.object({
  workspaceId: z.string().trim().min(1),
  snapshotId: z.string().trim().min(1),
  script: z.string().trim().min(1),
  voicePath: z.string().trim().min(1).optional(),
  presentationSettings: z.record(z.string(), z.unknown()).optional(),
  template: z.enum(['COMMERCIAL_OPINION', 'NEWS', 'STORE_PROMOTION', 'PRODUCT_INTRO']).optional(),
  pace: z.enum(['SLOW', 'NORMAL', 'FAST']).optional(),
  shotDensity: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  subtitleStyle: z.enum(['simple', 'commercial', 'emphasis', 'news']).optional(),
  audioPlan: z.record(z.string(), z.unknown()).optional(),
  brandingPlan: z.record(z.string(), z.unknown()).optional(),
  usePexels: z.boolean().optional(),
  sentences: z.array(z.object({ text: z.string().trim().min(1), startMs: z.number().nonnegative().optional(), endMs: z.number().positive().optional(), voiceStartMs: z.number().nonnegative().optional(), voiceEndMs: z.number().positive().optional(), durationMs: z.number().positive().optional() })).optional(),
});
const operationInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('REPLACE_CLIP'), sentenceId: z.string().min(1), assetId: z.string().min(1), sourceInMs: z.number().int().nonnegative().optional(), sourceSegmentId: z.string().min(1).optional() }),
  z.object({ type: z.literal('TRIM_SOURCE'), sentenceId: z.string().min(1), sourceInMs: z.number().int().nonnegative(), sourceOutMs: z.number().int().positive() }),
  z.object({ type: z.literal('LOCK_CLIP'), sentenceId: z.string().min(1) }),
  z.object({ type: z.literal('UNLOCK_CLIP'), sentenceId: z.string().min(1) }),
  z.object({ type: z.literal('MANUAL_SELECT_CLIP'), sentenceId: z.string().min(1), assetId: z.string().min(1), sourceInMs: z.number().int().nonnegative().optional(), sourceSegmentId: z.string().min(1).optional() }),
]);
const jianyingInput = z.object({ workspaceId: z.string().trim().min(1), draftPath: z.string().trim().min(1).optional(), draftPaths: z.array(z.string().trim().min(1)).min(1).optional() }).refine((value) => Boolean(value.draftPath || value.draftPaths?.length), { message: 'draftPath or draftPaths is required' });
const goldInput = z.object({ gold: z.boolean() });
const manualTagsInput = z.object({ tags: z.array(z.string().trim().min(1)).default([]) });

function errorCode(error: unknown): string { return error instanceof Error ? error.message : 'SCRIPT_EDITING_V3_FAILED'; }
function sourceRootId(root: string): string { return `local-${Buffer.from(root.toLowerCase()).toString('base64url').slice(0, 18)}`; }
function publicSnapshot(snapshot: Awaited<ReturnType<ScriptEditingV3Service['getSnapshot']>>) { return { ...snapshot, items: snapshot.items.map(({ sourcePath: _sourcePath, ...item }) => item) }; }
function publicSession(session: Awaited<ReturnType<ScriptEditingV3Service['getSession']>>) { return { ...session, cards: session.cards.map((card) => ({ ...card, ...(card.asset ? { asset: (({ sourcePath: _sourcePath, ...item }) => item)(card.asset) } : {}) })) }; }
function visualAnalysisConfig(): string { return `${process.env.QWEN_VL_MODEL || process.env.QWEN_MODEL || 'qwen-vl-max'}:${process.env.QWEN_MODEL_VERSION || 'unknown'}:qwen-visual-v2:asset-profile-v2`; }
function qwenConfigured(): boolean { return Boolean(process.env.QWEN_API_KEY?.trim() && (process.env.QWEN_BASE_URL?.trim() || process.env.QWEN_API_URL?.trim())); }

async function enqueueVisualAnalysisJobs(
  snapshot: Awaited<ReturnType<ScriptEditingV3Service['getSnapshot']>>,
  jobs: JobService,
): Promise<{ configured: boolean; queued: number; eligible: number }> {
  const eligible = snapshot.items.filter((item) => item.availability === 'VALID' && !item.disabled);
  if (!qwenConfigured()) return { configured: false, queued: 0, eligible: eligible.length };
  const analysisConfig = visualAnalysisConfig();
  await Promise.all(eligible.map((item) => jobs.createIdempotent({
    id: `job-${randomUUID()}`,
    projectId: null,
    workspaceId: snapshot.workspaceId,
    type: 'ANALYZE_ASSET_VISUAL',
    payload: { schemaVersion: 'ASSET_VISUAL_ANALYSIS_V1', snapshotId: snapshot.id, assetId: item.assetId, analysisConfig },
    idempotencyKey: `analyze-asset-visual:${snapshot.id}:${item.assetId}:${analysisConfig}`,
    maxAttempts: 3,
  })));
  return { configured: true, queued: eligible.length, eligible: eligible.length };
}

async function enqueueRepresentativeFrameJobs(
  snapshot: Awaited<ReturnType<ScriptEditingV3Service['getSnapshot']>>,
  jobs: JobService,
): Promise<number> {
  const eligible = snapshot.items.filter((item) => item.availability === 'VALID' && !item.disabled);
  if (qwenConfigured()) return 0;
  await Promise.all(eligible.map((item) => jobs.createIdempotent({
    id: `job-${randomUUID()}`,
    projectId: null,
    workspaceId: snapshot.workspaceId,
    type: 'GENERATE_REPRESENTATIVE_FRAMES',
    payload: { schemaVersion: 'REPRESENTATIVE_FRAMES_V1', snapshotId: snapshot.id, assetId: item.assetId },
    idempotencyKey: `generate-representative-frames:${snapshot.id}:${item.assetId}`,
    maxAttempts: 3,
  })));
  return eligible.length;
}

export function registerScriptEditingV3Routes(app: FastifyInstance, dependencies: { db: Pool; jobs: JobService; video: VideoService; assets: AssetService; localMedia: LocalMediaSourceService; localPathAccess?: LocalPathAccessService; storage?: LocalStorageProvider; jianyingRuntime?: JianyingRuntimeLocator }): void {
  const service = new ScriptEditingV3Service(dependencies.db, dependencies.storage ? { storage: dependencies.storage, hybridMedia: new HybridMediaService(dependencies.assets, dependencies.storage, createExternalVideoProvider(), dependencies.db) } : {});
  const jianyingRuntime = dependencies.jianyingRuntime || new JianyingRuntimeLocator();
  app.get('/api/v1/edit/v3/jianying/runtime', async (_request, reply) => {
    const status = await jianyingRuntime.getRuntimeStatus();
    return reply.send({
      platform: status.platform,
      helperConfigured: status.helper.configured,
      helperAvailable: status.helper.status === 'AVAILABLE',
      helperName: status.helper.path ? status.helper.path.split(/[\\/]/u).pop() : undefined,
      dllConfigured: status.dll.configured,
      dllAvailable: status.dll.status === 'AVAILABLE',
      dllName: status.dll.path ? status.dll.path.split(/[\\/]/u).pop() : undefined,
      encryptedDraftSupport: status.encryptedDraftSupport,
    });
  });
  app.post('/api/v1/edit/v3/scans', async (request, reply) => {
    const parsed = scanInput.safeParse(request.body || {}); if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } });
    const input = parsed.data; const canonical = dependencies.localPathAccess ? await dependencies.localPathAccess.authorize(input.sourceRoot, 'MEDIA_ROOT') : input.sourceRoot; const rootId = sourceRootId(canonical); const key = `v3-material-scan:${input.workspaceId}:${rootId}:${input.recursive}`; const existing = await dependencies.jobs.getByIdempotencyKey(key); if (existing) return reply.code(202).send({ scanId: (existing.payload as { scanId?: string }).scanId, jobId: existing.id, state: existing.state, sourceRootId: rootId });
    await dependencies.db.query("insert into video_workspaces (id,type,project_id) values ($1,'STANDALONE',null) on conflict (id) do nothing", [input.workspaceId]);
    const scanId = `scan-${randomUUID()}`; await dependencies.localMedia.createScan({ id: scanId, workspaceId: input.workspaceId, sourceRoot: canonical, sourceRootId: rootId, recursive: input.recursive });
    const job = await dependencies.jobs.createIdempotent({ id: `job-${randomUUID()}`, projectId: null, workspaceId: input.workspaceId, type: 'LOCAL_MEDIA_SCAN', payload: { schemaVersion: 'LOCAL_MEDIA_SCAN_V1', workspaceId: input.workspaceId, scanId, sourceRoot: canonical, sourceRootId: rootId, recursive: input.recursive }, idempotencyKey: key, maxAttempts: 3 });
    return reply.code(202).send({ scanId, jobId: job.id, state: job.state, sourceRootId: rootId });
  });
  app.get('/api/v1/edit/v3/scans/:id', async (request, reply) => { const workspaceId = String((request.query as { workspaceId?: string } | undefined)?.workspaceId || ''); if (!workspaceId) return reply.code(422).send({ error: { code: 'WORKSPACE_REQUIRED' } }); const scan = await dependencies.localMedia.getScan(String((request.params as { id: string }).id), undefined, workspaceId); if (!scan) return reply.code(404).send({ error: { code: 'LOCAL_MEDIA_SCAN_NOT_FOUND' } }); return { id: scan.id, status: scan.status, progress: scan.progress, sourceRootId: scan.sourceRootId, files: scan.files.map(({ sourcePath: _sourcePath, ...file }) => file) }; });

  app.post('/api/v1/edit/v3/pool/snapshots', async (request, reply) => { const parsed = snapshotInput.safeParse(request.body || {}); if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } }); try { await ensureStandaloneWorkspace(dependencies.db, parsed.data.workspaceId); const sourceFiles = await Promise.all(parsed.data.sourceFiles.map(async (sourceFile) => dependencies.localPathAccess ? dependencies.localPathAccess.authorize(sourceFile, 'PRIORITY_ASSET') : sourceFile)); for (const sourceFile of sourceFiles) if (!await access(sourceFile).then(() => true).catch(() => false)) throw new Error('LOCAL_MEDIA_FILE_NOT_FOUND'); const snapshot = await service.createMaterialPoolSnapshot({ ...parsed.data, sourceFiles }); const analysis = await enqueueVisualAnalysisJobs(snapshot, dependencies.jobs); const representativeFramesQueued = await enqueueRepresentativeFrameJobs(snapshot, dependencies.jobs); return reply.code(201).send({ ...publicSnapshot(snapshot), analysis, representativeFramesQueued }); } catch (error) { return reply.code(422).send({ error: { code: errorCode(error) } }); } });
  app.get('/api/v1/edit/v3/pool/snapshots/:id', async (request, reply) => { try { return publicSnapshot(await service.getSnapshot(String((request.params as { id: string }).id))); } catch (error) { return reply.code(404).send({ error: { code: errorCode(error) } }); } });
  app.get('/api/v1/edit/v3/pool/snapshots/:id/health', async (request, reply) => { try { return await service.getMaterialPoolHealth(String((request.params as { id: string }).id)); } catch (error) { return reply.code(404).send({ error: { code: errorCode(error) } }); } });
  app.post('/api/v1/edit/v3/pool/snapshots/:id/items/:assetId/gold', async (request, reply) => { const parsed = goldInput.safeParse(request.body || {}); if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } }); try { await service.setGold(String((request.params as { id: string; assetId: string }).id), String((request.params as { id: string; assetId: string }).assetId), parsed.data.gold); return { status: 'UPDATED', gold: parsed.data.gold }; } catch (error) { return reply.code(404).send({ error: { code: errorCode(error) } }); } });
  app.post('/api/v1/edit/v3/pool/snapshots/:id/items/:assetId/disabled', async (request, reply) => { const parsed = z.object({ disabled: z.boolean() }).safeParse(request.body || {}); if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } }); try { await service.setDisabled(String((request.params as { id: string; assetId: string }).id), String((request.params as { id: string; assetId: string }).assetId), parsed.data.disabled); return { status: 'UPDATED', disabled: parsed.data.disabled }; } catch (error) { return reply.code(404).send({ error: { code: errorCode(error) } }); } });
  app.post('/api/v1/edit/v3/pool/snapshots/:id/items/:assetId/tags', async (request, reply) => { const parsed = manualTagsInput.safeParse(request.body || {}); if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } }); try { const tags = await service.setManualTags(String((request.params as { id: string; assetId: string }).id), String((request.params as { id: string; assetId: string }).assetId), parsed.data.tags); return { status: 'UPDATED', tags }; } catch (error) { return reply.code(404).send({ error: { code: errorCode(error) } }); } });
   app.post('/api/v1/edit/v3/pool/snapshots/:id/analyze', async (request, reply) => { const snapshotId = String((request.params as { id: string }).id); const body = z.object({ assetId: z.string().trim().min(1) }).safeParse(request.body || {}); if (!body.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', details: body.error.issues } }); const snapshot = await service.getSnapshot(snapshotId).catch(() => null); if (!snapshot) return reply.code(404).send({ error: { code: 'MATERIAL_POOL_SNAPSHOT_NOT_FOUND' } }); const item = snapshot.items.find((candidate) => candidate.assetId === body.data.assetId); if (!item) return reply.code(404).send({ error: { code: 'MATERIAL_NOT_FOUND' } }); if (item.availability !== 'VALID' || item.disabled) return reply.code(422).send({ error: { code: 'MATERIAL_NOT_ELIGIBLE_FOR_ANALYSIS' } }); if (!qwenConfigured()) return reply.code(503).send({ error: { code: 'QWEN_PROVIDER_NOT_CONFIGURED' } }); const analysisConfig = visualAnalysisConfig(); const key = `analyze-asset-visual:${snapshotId}:${body.data.assetId}:${analysisConfig}`; const job = await dependencies.jobs.createIdempotent({ id: `job-${randomUUID()}`, projectId: null, workspaceId: snapshot.workspaceId, type: 'ANALYZE_ASSET_VISUAL', payload: { schemaVersion: 'ASSET_VISUAL_ANALYSIS_V1', snapshotId, assetId: body.data.assetId, analysisConfig }, idempotencyKey: key, maxAttempts: 3 }); return reply.code(202).send({ jobId: job.id, state: job.state }); });
  app.post('/api/v1/edit/v3/pool/snapshots/:id/analyze-all', async (request, reply) => { const snapshot = await service.getSnapshot(String((request.params as { id: string }).id)).catch(() => null); if (!snapshot) return reply.code(404).send({ error: { code: 'MATERIAL_POOL_SNAPSHOT_NOT_FOUND' } }); return reply.code(202).send({ snapshotId: snapshot.id, analysis: await enqueueVisualAnalysisJobs(snapshot, dependencies.jobs) }); });
  app.get('/api/v1/edit/v3/media/:assetId', async (request, reply) => { const query = request.query as { snapshotId?: string }; if (!query.snapshotId) return reply.code(422).send({ error: { code: 'SNAPSHOT_REQUIRED' } }); try { const snapshot = await service.getSnapshot(query.snapshotId); const assetId = String((request.params as { assetId: string }).assetId); const item = snapshot.items.find((candidate) => candidate.assetId === assetId); let sourcePath = item?.sourcePath; let fileName = item?.fileName || assetId; if (!sourcePath && dependencies.storage) { const row = (await dependencies.db.query('select a.storage_key,a.metadata from assets a join video_workspace_assets wa on wa.asset_id=a.id and wa.workspace_id=$1 and wa.role=\'SOURCE\' where a.id=$2 and a.lifecycle=\'READY\'', [snapshot.workspaceId, assetId])).rows[0] as { storage_key?: string; metadata?: Record<string, unknown> } | undefined; if (row?.storage_key) { sourcePath = dependencies.storage.objectPath(String(row.storage_key)); const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}; fileName = typeof metadata.originalName === 'string' ? metadata.originalName : fileName; } } if (!sourcePath) return reply.code(404).send({ error: { code: 'MATERIAL_NOT_FOUND' } }); const details = await stat(sourcePath).catch(() => null); if (!details?.isFile()) return reply.code(404).send({ error: { code: 'MATERIAL_FILE_NOT_FOUND' } }); const mime = ({ mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo' } as Record<string, string>)[extname(fileName).slice(1).toLowerCase()] || 'video/mp4'; reply.header('accept-ranges', 'bytes').header('content-type', mime); const range = request.headers.range; if (!range) return reply.header('content-length', details.size).send(createReadStream(sourcePath)); const match = /^bytes=(\d*)-(\d*)$/u.exec(range); if (!match) return reply.code(416).send(); const start = match[1] ? Number(match[1]) : Math.max(0, details.size - Number(match[2] || 0)); const end = match[2] ? Number(match[2]) : details.size - 1; if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= details.size) return reply.code(416).header('content-range', `bytes */${details.size}`).send(); return reply.code(206).header('content-length', end - start + 1).header('content-range', `bytes ${start}-${end}/${details.size}`).send(createReadStream(sourcePath, { start, end })); } catch (error) { return reply.code(404).send({ error: { code: errorCode(error) } }); } });

  app.post('/api/v1/edit/v3/sessions', async (request, reply) => { const parsed = sessionInput.safeParse(request.body || {}); if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } }); try { const input = parsed.data; await ensureStandaloneWorkspace(dependencies.db, input.workspaceId); const timingScript = input.sentences?.length ? input.sentences.map((sentence) => sentence.text).join('。') : input.script; const timing = input.voicePath ? await prepareVoiceTiming({ assetService: dependencies.assets, assets: new AssetCatalogService(dependencies.db) }, { workspaceId: input.workspaceId, script: timingScript, voicePath: input.voicePath }) : undefined; let cursor = 0; const sentences = timing?.sentences.map((sentence, index) => { const durationMs = Number(sentence.durationMs || 3_000); const startMs = sentence.voiceStartMs ?? cursor; const endMs = sentence.voiceEndMs ?? startMs + durationMs; cursor = Math.max(cursor, endMs); return { text: input.sentences?.[index]?.text || sentence.text, startMs, endMs, durationMs: endMs - startMs }; }) || input.sentences; const { presentationSettings, template, pace, shotDensity, subtitleStyle, audioPlan, brandingPlan, usePexels, ...session } = input; const settings = { ...(presentationSettings ? { presentationSettings } : {}), ...(template ? { template } : {}), ...(pace ? { pace } : {}), ...(shotDensity ? { shotDensity } : {}), ...(subtitleStyle ? { subtitleStyle } : {}), ...(audioPlan ? { audioPlan } : {}), ...(brandingPlan ? { brandingPlan } : {}), ...(usePexels !== undefined ? { usePexels } : {}) }; return reply.code(201).send(await service.createSession({ ...session, ...(Object.keys(settings).length ? { settings } : {}), ...(sentences ? { sentences } : {}) })); } catch (error) { return reply.code(422).send({ error: { code: errorCode(error) } }); } });
  app.get('/api/v1/edit/v3/sessions/:id', async (request, reply) => { try { return publicSession(await service.getSession(String((request.params as { id: string }).id))); } catch (error) { return reply.code(404).send({ error: { code: errorCode(error) } }); } });
  app.post('/api/v1/edit/v3/sessions/:id/generate', async (request, reply) => { try { return reply.code(201).send(await service.generate(String((request.params as { id: string }).id))); } catch (error) { return reply.code(422).send({ error: { code: errorCode(error) } }); } });
  app.post('/api/v1/edit/v3/sessions/:id/operations', async (request, reply) => { const parsed = operationInput.safeParse(request.body || {}); if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } }); try { return reply.code(201).send(await service.applyOperation(String((request.params as { id: string }).id), parsed.data)); } catch (error) { const code = errorCode(error); return reply.code(code.includes('LOCKED') ? 409 : 422).send({ error: { code } }); } });
  app.post('/api/v1/edit/v3/sessions/:id/render', async (request, reply) => { const id = String((request.params as { id: string }).id); const row = (await dependencies.db.query('select workspace_id,current_manifest_id,revision from script_editing_v3_sessions where id=$1', [id])).rows[0] as { workspace_id?: string; current_manifest_id?: string; revision?: number } | undefined; if (!row?.workspace_id || !row.current_manifest_id) return reply.code(409).send({ error: { code: 'SCRIPT_EDITING_V3_MANIFEST_NOT_READY' } }); const job = await dependencies.video.createManifestRenderJobForWorkspace(row.workspace_id, row.current_manifest_id, `script-editing-v3:${id}:revision:${Number(row.revision || 1)}`); await dependencies.db.query("update script_editing_v3_sessions set status='RENDERING',updated_at=now() where id=$1", [id]); return reply.code(202).send({ jobId: job.id, manifestId: row.current_manifest_id, status: 'RENDERING' }); });
  app.get('/api/v1/edit/v3/sessions/:id/rendered', async (request, reply) => { if (!dependencies.storage) return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE' } }); const id = String((request.params as { id: string }).id); const row = (await dependencies.db.query('select a.storage_key from script_editing_v3_sessions s join renders r on r.manifest_id=s.current_manifest_id and r.status=\'SUCCEEDED\' join assets a on a.id=r.output_asset_id where s.id=$1 order by r.finished_at desc nulls last limit 1', [id])).rows[0] as { storage_key?: string } | undefined; if (!row?.storage_key) return reply.code(404).send({ error: { code: 'V3_RENDER_NOT_READY' } }); const path = dependencies.storage.objectPath(row.storage_key); const details = await stat(path).catch(() => null); if (!details?.isFile()) return reply.code(404).send({ error: { code: 'V3_RENDER_FILE_NOT_FOUND' } }); return reply.header('content-type', 'video/mp4').header('content-length', details.size).send(createReadStream(path)); });

  app.post('/api/v1/edit/v3/jianying/import', async (request, reply) => { const parsed = jianyingInput.safeParse(request.body || {}); if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } }); try { await ensureStandaloneWorkspace(dependencies.db, parsed.data.workspaceId); const paths = [...new Set([...(parsed.data.draftPath ? [parsed.data.draftPath] : []), ...(parsed.data.draftPaths || [])])]; const authorizedPaths = []; for (const draftPath of paths) { const path = dependencies.localPathAccess ? await dependencies.localPathAccess.authorize(draftPath, 'JIANYING_DRAFT') : draftPath; if (!await access(path).then(() => true).catch(() => false)) throw new Error('JIANYING_DRAFT_NOT_FOUND'); authorizedPaths.push(path); } const digest = createHash('sha256').update(`${parsed.data.workspaceId}:${authorizedPaths.join('\0')}`).digest('hex'); const key = `jianying-import:${parsed.data.workspaceId}:${digest}`; const existing = await dependencies.jobs.getByIdempotencyKey(key); if (existing) return reply.code(202).send({ jobId: existing.id, state: existing.state }); const job = await dependencies.jobs.createIdempotent({ id: `job-${randomUUID()}`, projectId: null, workspaceId: parsed.data.workspaceId, type: 'IMPORT_JIANYING_DRAFT', payload: { schemaVersion: 'JIANYING_DRAFT_IMPORT_V1', workspaceId: parsed.data.workspaceId, draftPaths: authorizedPaths }, idempotencyKey: key, maxAttempts: 3 }); return reply.code(202).send({ jobId: job.id, state: job.state }); } catch (error) { return reply.code(422).send({ error: { code: errorCode(error) } }); } });
}
