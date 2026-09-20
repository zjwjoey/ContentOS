import { dirname, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import type { Pool } from 'pg';
import { AssetCatalogService, type AssetService, type LocalMediaSourceService } from '../../../packages/modules/asset/src/index.js';
import type { JobLeaseCancellationHandler, JobRecord, JobService } from '../../../packages/modules/job/src/index.js';
import { planEditorialScript, prepareEditingWorkbenchItem, prepareVoiceTiming, resolveEditorialPlan, rerollEditorialClip, ScriptEditingV3Service, QwenVisualAnalysisProvider, VideoAdjustmentService, VideoEditPresetService, HybridMediaService, type EditorialAssetV1, type ExternalVideoProvider, type PlannerAsset, type VideoJobPayload, type VideoService } from '../../../packages/modules/video/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import type { LocalPathAccessService } from '../../../packages/modules/local-path/src/index.js';
import { renderEditManifest } from '../../../packages/infrastructure/ffmpeg/src/index.js';

export interface VideoHandlerDeps { db: Pool; storage: LocalStorageProvider; assets: AssetService; jobs: JobService; video: VideoService; ffmpegPath: string; ffprobePath: string; fontFile?: string; localMedia?: LocalMediaSourceService; localPathAccess?: LocalPathAccessService; mediaProvider?: ExternalVideoProvider; }

export function createVisualAnalysisJobHandler(deps: VideoHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, _attemptId, signal) => {
    if (job.type !== 'ANALYZE_ASSET_VISUAL') throw new Error('ANALYZE_ASSET_VISUAL_JOB_TYPE_INVALID');
    if (signal.aborted) throw new Error('ANALYZE_ASSET_VISUAL_CANCELLED');
    const payload = job.payload as { assetId?: string };
    if (!payload.assetId) throw new Error('ANALYZE_ASSET_VISUAL_PAYLOAD_INVALID');
    if (!deps.localMedia) throw new Error('LOCAL_MEDIA_SERVICE_UNAVAILABLE');
    const generated = await deps.localMedia.generateThumbnail(payload.assetId, deps.ffmpegPath).catch(() => null);
    const row = (await deps.db.query('select thumbnail_key from local_media_index where file_id=$1 and availability=\'AVAILABLE\'', [payload.assetId])).rows[0] as { thumbnail_key?: string } | undefined;
    const framePath = generated?.path || (row?.thumbnail_key ? `${deps.storage.root}/thumbnails/${row.thumbnail_key}` : undefined);
    if (!framePath) throw new Error('REPRESENTATIVE_FRAME_NOT_READY');
    const profile = await new QwenVisualAnalysisProvider().analyzeAssetFrames({ assetId: payload.assetId, framePaths: [framePath] });
    await new ScriptEditingV3Service(deps.db).persistVisualProfile(profile);
    return { assetId: payload.assetId, status: 'READY', profile };
  };
}

async function chooseLocalMusic(category: string | undefined, seed: number): Promise<string | undefined> {
  const roots = (process.env.CONTENTOS_MUSIC_ROOTS || '').split(';').map((value) => value.trim()).filter(Boolean); const files: string[] = []; const wanted = category?.toLocaleLowerCase();
  const visit = async (directory: string): Promise<void> => { const entries = await readdir(directory, { withFileTypes: true }).catch(() => []); for (const entry of entries) { if (entry.isSymbolicLink()) continue; const path = resolve(directory, entry.name); if (entry.isDirectory()) await visit(path); else if (entry.isFile() && ['.mp3', '.wav', '.m4a', '.aac', '.flac'].includes(extname(entry.name).toLocaleLowerCase()) && (!wanted || directory.toLocaleLowerCase().includes(wanted) || entry.name.toLocaleLowerCase().includes(wanted))) files.push(path); } };
  for (const root of roots) { const actual = await realpath(root).catch(() => null); if (actual) await visit(actual); }
  if (!files.length && wanted) for (const root of roots) { const actual = await realpath(root).catch(() => null); if (actual) await visit(actual); }
  files.sort((a, b) => a.localeCompare(b)); return files.length ? files[Math.abs(seed) % files.length] : undefined;
}

export function createScriptPlanJobHandler(deps: VideoHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, _attemptId, signal) => {
    try {
    if (job.type !== 'EDIT_SCRIPT_PLAN') throw new Error('EDIT_SCRIPT_PLAN_JOB_TYPE_INVALID');
    if (signal.aborted) throw new Error('EDIT_SCRIPT_PLAN_CANCELLED');
    const payload = job.payload as { planId?: string; operation?: string; clipId?: string; localOnly?: boolean };
    const planId = payload.planId;
    if (!planId) throw new Error('EDIT_SCRIPT_PLAN_PAYLOAD_INVALID');
    const row = (await deps.db.query('select id, resolved_plan, editorial_plan, settings, source_roots, script, voice_asset_id from edit_script_plans where id=$1', [planId])).rows[0] as { id: string; resolved_plan: unknown; editorial_plan: unknown; settings: Record<string, unknown>; source_roots: unknown; script: string; voice_asset_id?: string | null } | undefined;
    if (!row) throw new Error('EDIT_SCRIPT_PLAN_NOT_FOUND');
    await deps.db.query("update edit_script_plans set status='PLANNING',updated_at=now() where id=$1", [planId]);
    if (payload.operation === 'REROLL_CLIP') {
      if (!row.resolved_plan) throw new Error('SCRIPT_PLAN_NOT_READY');
      const assets = Array.isArray(row.settings?.assets) ? row.settings.assets as EditorialAssetV1[] : [];
      const priorityAssets = Array.isArray(row.settings?.priorityAssets) ? row.settings.priorityAssets as Array<{ assetId: string; mode: 'PREFER' | 'MUST_USE'; path?: string }> : [];
      let rerolled = row.resolved_plan as import('../../../packages/modules/video/src/index.js').ResolvedEditorialPlanV1;
      const options = { localOnly: payload.localOnly === true, priorityAssets, allowControlledReuse: true, seed: Number(row.settings?.seed || 1) };
      if (payload.clipId) rerolled = rerollEditorialClip(rerolled, assets, payload.clipId, options);
      else for (const slot of rerolled.scenes.flatMap((scene) => scene.clipSlots).filter((candidate) => !candidate.locked)) rerolled = rerollEditorialClip(rerolled, assets, slot.id, options);
      await deps.db.query("update edit_script_plans set resolved_plan=$2,settings=settings - 'pendingReroll',status='READY',updated_at=now() where id=$1", [planId, rerolled]);
      return { planId, status: 'READY', operation: 'REROLL_CLIP' };
    }
    let editorial = row.editorial_plan as import('../../../packages/modules/video/src/index.js').EditorialPlanV1 | null;
    if (editorial) {
      const voicePath = typeof row.settings?.voicePath === 'string' ? await authorizedVoicePath(row.settings.voicePath, deps.localPathAccess) : undefined;
      const hasExplicitVoiceTiming = editorial.sentences.length > 0 && editorial.sentences.every((sentence) => sentence.voiceStartMs !== undefined && sentence.voiceEndMs !== undefined);
      const voiceTiming = await prepareVoiceTiming({ assetService: deps.assets, assets: new AssetCatalogService(deps.db) }, { workspaceId: job.workspaceId || 'workspace-local', script: row.script, ...(hasExplicitVoiceTiming ? { sentences: editorial.sentences } : {}), ...(row.voice_asset_id ? { voiceAssetId: String(row.voice_asset_id) } : {}), ...(voicePath ? { voicePath } : {}) });
      if (voiceTiming.voiceAssetId && voiceTiming.voiceAssetId !== row.voice_asset_id) {
        await deps.db.query('update edit_script_plans set voice_asset_id=$2 where id=$1', [planId, voiceTiming.voiceAssetId]);
      }
      if (voiceTiming.sentences.length && JSON.stringify(voiceTiming.sentences) !== JSON.stringify(editorial.sentences)) {
        editorial = planEditorialScript({ sentences: voiceTiming.sentences, template: editorial.templateId, pace: editorial.pace, shotDensity: editorial.shotDensity, subtitleStyle: editorial.subtitlePlan.style, heroText: row.settings?.heroText !== false, ...(Array.isArray(row.settings?.heroTextPolicy) ? { heroTextPolicy: row.settings.heroTextPolicy.filter((value): value is 'HOOK' | 'ENDING' | 'EVIDENCE' => value === 'HOOK' || value === 'ENDING' || value === 'EVIDENCE') } : {}), knownEntities: Array.isArray(row.settings?.knownEntities) ? row.settings.knownEntities.filter((value): value is string => typeof value === 'string') : [], manualKeywords: Array.isArray(row.settings?.manualKeywords) ? row.settings.manualKeywords.filter((value): value is string => typeof value === 'string') : [], audioPlan: editorial.audioPlan, brandingPlan: editorial.brandingPlan });
        await deps.db.query('update edit_script_plans set editorial_plan=$2,resolved_plan=null where id=$1', [planId, editorial]);
        row.resolved_plan = null;
      }
    }
    if (!row.resolved_plan && editorial) {
      const scannedAssets: EditorialAssetV1[] = Array.isArray(row.settings?.assets) ? row.settings.assets as EditorialAssetV1[] : [];
      const sourceRoots = Array.isArray(row.source_roots) ? row.source_roots : [];
      const knownEntities = Array.isArray(row.settings?.knownEntities) ? row.settings.knownEntities.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())) : [];
      if (deps.localMedia && sourceRoots.length) {
        for (const root of [...new Set(sourceRoots.filter((item): item is string => typeof item === 'string'))]) {
          // V2 plans belong to a workspace, so persist the scan there as well as
          // returning the in-memory candidates. This makes the existing secure
          // thumbnail endpoint usable by the Scene Card preview.
          const scanId = `edit-v2-scan-${randomUUID()}`;
          await deps.localMedia.createScan({ id: scanId, workspaceId: job.workspaceId || 'workspace-local', sourceRoot: root, recursive: true });
          await deps.localMedia.markScanRunning(scanId);
          const scan = await deps.localMedia.scan({ sourceRoot: root, recursive: true, signal });
          await deps.localMedia.completeScan(scanId, scan);
          for (const file of scan.files.filter((item) => item.available)) {
            if (signal.aborted) throw new Error('EDIT_SCRIPT_PLAN_CANCELLED');
            try { await deps.localMedia.generateThumbnail(`${scan.sourceRootId}:${file.relativePath}`, deps.ffmpegPath); } catch { /* preview can still use metadata if a thumbnail fails */ }
          }
          scannedAssets.push(...scan.files.filter((file) => file.available).map((file) => { const id = `${scan.sourceRootId}:${file.relativePath}`; const terms = `${file.fileName} ${(file.tags || []).join(' ')}`.toLocaleLowerCase(); const entity = knownEntities.find((candidate) => terms.includes(candidate.toLocaleLowerCase())); return { id, path: file.sourcePath, durationMs: file.durationMs, source: 'LOCAL' as const, originalName: file.fileName, keywords: file.tags, tags: file.tags, thumbnailUrl: `/api/v1/video/local-media/thumbnails/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(job.workspaceId || 'workspace-local')}`, ...(entity ? { entity } : {}) }; }));
        }
      }
      if (row.settings?.usePexels === true && deps.mediaProvider) {
        const timedSentences = editorial.sentences || [];
        const hybrid = await new HybridMediaService(deps.assets, deps.storage, deps.mediaProvider, deps.db).resolve({ workspaceId: job.workspaceId || 'workspace-local', script: timedSentences.map((sentence) => sentence.text).join(' '), sentences: timedSentences, localAssets: scannedAssets.map((asset) => ({ id: asset.id, storageKey: asset.id, sourcePath: asset.path, durationMs: asset.durationMs, ...(asset.originalName ? { originalName: asset.originalName } : {}), ...(asset.tags ? { tags: asset.tags } : {}) })), usePexels: true, ...(signal ? { signal } : {}) });
        scannedAssets.push(...hybrid.assets.map((asset) => {
          const external = asset.metadata?.external as Record<string, unknown> | undefined;
          const source = external ? (String(external.provider || '').includes('fake') ? 'FAKE_PEXELS' as const : 'PEXELS' as const) : 'LOCAL' as const;
          return { id: asset.id, path: asset.sourcePath, durationMs: asset.durationMs, source, originalName: external ? `${source === 'FAKE_PEXELS' ? '网络模拟' : 'Pexels'}-${String(external.providerAssetId || asset.id)}` : asset.id, keywords: [], ...(external?.creatorName ? { author: String(external.creatorName) } : {}), ...(external ? { thumbnailUrl: `/api/v1/video/workspace-assets/${encodeURIComponent(asset.id)}/thumbnail?workspaceId=${encodeURIComponent(job.workspaceId || 'workspace-local')}` } : {}) };
        }));
      }
      const rawPriority = Array.isArray(row.settings.priorityAssets) ? row.settings.priorityAssets as Array<{ assetId: string; mode: 'PREFER' | 'MUST_USE'; path?: string }> : [];
      const priorityAssets = rawPriority.map((item) => { const match = scannedAssets.find((asset) => asset.id === item.assetId || asset.path === item.assetId || asset.path === item.path); return { assetId: match?.id ?? item.assetId, mode: item.mode, ...(item.path ? { path: item.path } : {}) }; });
      let resolved = resolveEditorialPlan(editorial, scannedAssets, Number(row.settings.seed || 1), { priorityAssets, allowControlledReuse: true });
      if (resolved.audioPlan.backgroundMusicMode === 'AUTO' && !resolved.audioPlan.path) { const musicPath = await chooseLocalMusic(resolved.audioPlan.category, Number(row.settings.seed || 1)); if (musicPath) resolved = { ...resolved, audioPlan: { ...resolved.audioPlan, path: musicPath } }; else resolved = { ...resolved, warnings: [...(resolved.warnings || []), 'EDIT_BGM_UNAVAILABLE'] }; }
      await deps.db.query("update edit_script_plans set resolved_plan=$2,settings=settings || $3::jsonb,status='READY',updated_at=now() where id=$1", [planId, resolved, JSON.stringify({ assets: scannedAssets })]);
      return { planId, status: 'READY' };
    }
    if (!row.resolved_plan) { await deps.db.query("update edit_script_plans set status='FAILED',updated_at=now() where id=$1", [planId]); throw new Error('EDIT_SCRIPT_PLAN_NO_RESOLVED_MEDIA'); }
    let existingPlan = row.resolved_plan as { audioPlan?: { backgroundMusicMode?: string; path?: string; category?: string; [key: string]: unknown }; warnings?: string[] };
    if (existingPlan.audioPlan?.backgroundMusicMode === 'AUTO' && !existingPlan.audioPlan.path) { const musicPath = await chooseLocalMusic(existingPlan.audioPlan.category, Number(row.settings.seed || 1)); existingPlan = musicPath ? { ...existingPlan, audioPlan: { ...existingPlan.audioPlan, path: musicPath } } : { ...existingPlan, warnings: [...(existingPlan.warnings || []), 'EDIT_BGM_UNAVAILABLE'] }; await deps.db.query('update edit_script_plans set resolved_plan=$2 where id=$1', [planId, existingPlan]); }
    await deps.db.query("update edit_script_plans set status='READY',updated_at=now() where id=$1", [planId]);
    return { planId, status: 'READY' };
    } catch (error) {
      await deps.db.query("update edit_script_plans set status='FAILED',updated_at=now() where id=$1 and status in ('QUEUED','PLANNING')", [((job.payload as { planId?: string }).planId || '')]).catch(() => undefined);
      throw error;
    }
  };
}

async function syncEditBatch(db: Pool, batchId: string): Promise<void> {
  const row = (await db.query<{ expected: number; actual: number; succeeded: number; failed: number; active: number }>(`select b.total_count as expected, count(i.id)::int as actual,
    count(*) filter (where i.state='SUCCEEDED')::int as succeeded,
    count(*) filter (where i.state='FAILED')::int as failed,
    count(*) filter (where i.state in ('QUEUED','PREPARING','RENDERING','RUNNING'))::int as active
    from edit_batches b left join edit_batch_items i on i.batch_id=b.id where b.id=$1 group by b.total_count`, [batchId])).rows[0];
  if (!row) return;
  const incomplete = Number(row.actual) !== Number(row.expected);
  const status = incomplete ? 'FAILED' : Number(row.active) > 0 ? 'RUNNING' : Number(row.failed) > 0 && Number(row.succeeded) > 0 ? 'PARTIAL' : Number(row.expected) > 0 && Number(row.failed) === Number(row.expected) ? 'FAILED' : Number(row.expected) > 0 && Number(row.succeeded) === Number(row.expected) ? 'SUCCEEDED' : 'RUNNING';
  await db.query('update edit_batches set status=$2,succeeded_count=$3,failed_count=$4,updated_at=now() where id=$1', [batchId, status, row.succeeded, Number(row.failed) + (incomplete && Number(row.expected) > Number(row.actual) ? Number(row.expected) - Number(row.actual) : 0)]);
}

async function syncEditBatchForItem(db: Pool, itemId: string): Promise<void> {
  const row = (await db.query<{ batch_id: string }>('select batch_id from edit_batch_items where id=$1', [itemId])).rows[0];
  if (row) await syncEditBatch(db, row.batch_id);
}

async function authorizedVoicePath(input: string, accessService?: LocalPathAccessService): Promise<string> {
  if (accessService) return accessService.authorize(input, 'VOICE_FILE');
  const roots = (process.env.CONTENTOS_LOCAL_MEDIA_ROOTS || '').split(';').map((value) => value.trim()).filter(Boolean);
  const candidate = await realpath(input).catch(() => null);
  if (!candidate || !(await stat(candidate).then((value) => value.isFile()).catch(() => false))) throw new Error('EDIT_VOICE_PATH_UNAUTHORIZED');
  const authorized = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
  const contained = authorized.some((root) => root && (candidate.toLowerCase() === root.toLowerCase() || candidate.toLowerCase().startsWith(`${root}${sep}`.toLowerCase())));
  if (!contained) throw new Error('EDIT_VOICE_PATH_UNAUTHORIZED');
  return candidate;
}

async function authorizedOutputPath(outputPath: string, outputRoot: string, accessService?: LocalPathAccessService): Promise<void> {
  if (!outputPath || !outputRoot || outputPath.includes('\0') || outputRoot.includes('\0')) throw new Error('EDIT_OUTPUT_ROOT_INVALID');
  if (accessService) {
    const authorizedRoot = await accessService.authorize(outputRoot, 'OUTPUT_ROOT');
    const target = resolve(outputPath);
    const prefix = authorizedRoot.endsWith(sep) ? authorizedRoot : `${authorizedRoot}${sep}`;
    if (target.toLocaleLowerCase() !== authorizedRoot.toLocaleLowerCase() && !target.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) throw new Error('EDIT_OUTPUT_ROOT_UNAUTHORIZED');
    return;
  }
  const roots = (process.env.CONTENTOS_OUTPUT_ROOTS || '').split(';').map((value) => value.trim()).filter(Boolean);
  const [configured, actualRoot, parent, rootStat] = await Promise.all([Promise.all(roots.map((root) => realpath(root).catch(() => null))), realpath(outputRoot).catch(() => null), realpath(dirname(outputPath)).catch(() => null), stat(outputRoot).catch(() => null)]);
  if (!actualRoot || !parent || !rootStat?.isDirectory() || !configured.some((root) => root && (actualRoot.toLowerCase() === root.toLowerCase() || actualRoot.toLowerCase().startsWith(`${root}${sep}`.toLowerCase())))) throw new Error('EDIT_OUTPUT_ROOT_UNAUTHORIZED');
  if (!(parent.toLowerCase() === actualRoot.toLowerCase() || parent.toLowerCase().startsWith(`${actualRoot}${sep}`.toLowerCase()))) throw new Error('EDIT_OUTPUT_ROOT_UNAUTHORIZED');
}

export function createEditPrepareJobHandler(deps: VideoHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, _attemptId, signal) => {
    if (job.type !== 'EDIT_PREPARE_ITEM') throw new Error('EDIT_PREPARE_JOB_TYPE_INVALID');
    if (signal.aborted) throw new Error('EDIT_PREPARE_CANCELLED');
    const payload = job.payload as { batchId?: string; itemId?: string; workspaceId?: string };
    if (!payload.batchId || !payload.itemId || !payload.workspaceId) throw new Error('EDIT_PREPARE_PAYLOAD_INVALID');
    const row = (await deps.db.query('select i.*, b.mode, s.settings from edit_batch_items i join edit_batches b on b.id = i.batch_id join edit_workbench_sessions s on s.id = b.session_id where i.id=$1 and i.batch_id=$2 and i.workspace_id=$3', [payload.itemId, payload.batchId, payload.workspaceId])).rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error('EDIT_PREPARE_ITEM_NOT_FOUND');
    await deps.db.query("update edit_batch_items set state='PREPARING',error=null,updated_at=now() where id=$1 and state in ('QUEUED','PREPARING','FAILED')", [payload.itemId]);
    try {
      const settings = row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings) ? row.settings as Record<string, unknown> : {};
      const itemSettings = row.settings_snapshot && typeof row.settings_snapshot === 'object' && !Array.isArray(row.settings_snapshot) ? row.settings_snapshot as Record<string, unknown> : {};
      const scanAssets = Array.isArray(settings.scanAssets) ? settings.scanAssets : [];
      const voicePath = row.voice_path ? await authorizedVoicePath(String(row.voice_path), deps.localPathAccess) : undefined;
      let plannedAssets = scanAssets as PlannerAsset[];
      let hybridDiagnostics: Record<string, unknown> | undefined;
      const catalog = new AssetCatalogService(deps.db);
      const voiceTiming = await prepareVoiceTiming({ assetService: deps.assets, assets: catalog }, { workspaceId: payload.workspaceId, script: String(row.script), ...(row.voice_asset_id ? { voiceAssetId: String(row.voice_asset_id) } : {}), ...(voicePath ? { voicePath } : {}), ...(settings.presentationSettings ? { presentationSettings: settings.presentationSettings as import('../../../packages/contracts/src/index.js').PresentationSettingsV1 } : {}) });
      if (String(row.mode) === 'SCRIPT' && settings.usePexels === true) {
        await deps.db.query("update edit_batch_items set settings_snapshot=settings_snapshot || $2::jsonb,updated_at=now() where id=$1", [payload.itemId, JSON.stringify({ phase: 'VISUAL_PLANNING' })]);
        await deps.db.query("update edit_batch_items set settings_snapshot=settings_snapshot || $2::jsonb,updated_at=now() where id=$1", [payload.itemId, JSON.stringify({ phase: 'LOCAL_MATCHING' })]);
        const hybrid = await new HybridMediaService(deps.assets, deps.storage, deps.mediaProvider, deps.db).resolve({ workspaceId: payload.workspaceId, script: String(row.script), sentences: voiceTiming.sentences, localAssets: scanAssets as Array<PlannerAsset & { originalName?: string; tags?: string[]; metadata?: Record<string, unknown> }>, usePexels: true, minClipDurationMs: Number(itemSettings.minClipDurationMs || 2_000), maxClipDurationMs: Number(itemSettings.maxClipDurationMs || 5_000), signal });
        plannedAssets = hybrid.assets;
        hybridDiagnostics = { ...hybrid.diagnostics, visualPlan: hybrid.plan, resolvedVisualPlan: hybrid.resolvedPlan, resolvedAssignments: hybrid.resolvedAssignments };
        await deps.db.query("update edit_batch_items set settings_snapshot=settings_snapshot || $2::jsonb,updated_at=now() where id=$1", [payload.itemId, JSON.stringify({ phase: 'MANIFEST_BUILDING', hybridDiagnostics })]);
      }
      const quickEdit = new VideoAdjustmentService(deps.db, catalog, deps.localMedia);
      const result = await prepareEditingWorkbenchItem({ assetService: deps.assets, assets: catalog, quickEdit, storage: deps.storage, video: deps.video, presets: new VideoEditPresetService(deps.db) }, {
        mode: String(row.mode) as 'SCRIPT' | 'MIX', workspaceId: payload.workspaceId, script: String(row.script), ...(voiceTiming.voiceAssetId ? { voiceAssetId: voiceTiming.voiceAssetId } : {}), sentences: voiceTiming.sentences, assets: plannedAssets, ...(hybridDiagnostics && Array.isArray(hybridDiagnostics.resolvedAssignments) ? { resolvedAssignments: hybridDiagnostics.resolvedAssignments as import('../../../packages/modules/video/src/index.js').ResolvedVisualAssignment[] } : {}), ...((itemSettings.presentationSettings || settings.presentationSettings) ? { presentationSettings: (itemSettings.presentationSettings || settings.presentationSettings) as import('../../../packages/contracts/src/index.js').PresentationSettingsV1 } : {}), seed: Number(itemSettings.seed || 1), minClipDurationMs: Number(itemSettings.minClipDurationMs || 2_000), maxClipDurationMs: Number(itemSettings.maxClipDurationMs || 5_000), preferUnusedMedia: itemSettings.preferUnusedMedia !== false, fps: Number(itemSettings.fps || 30), ...(typeof itemSettings.templateId === 'string' && itemSettings.templateId ? { templateId: itemSettings.templateId } : {}), renderIdempotencySuffix: `edit-item-${payload.itemId}`
      });
      await deps.db.query("update edit_batch_items set voice_asset_id=$2,manifest_id=$3,job_id=$4,state='RENDERING',error=null,settings_snapshot=settings_snapshot || $5::jsonb,updated_at=now() where id=$1", [payload.itemId, result.voiceAssetId || row.voice_asset_id || null, result.manifestId, result.renderJobId, JSON.stringify({ phase: 'RENDERING', ...(hybridDiagnostics ? { hybridDiagnostics } : {}) })]);
      await syncEditBatchForItem(deps.db, payload.itemId);
      return result;
    } catch (error) {
      const failure = { code: error instanceof Error ? error.message : 'EDIT_ITEM_PREPARE_FAILED', message: error instanceof Error ? error.message : '编辑任务准备失败' };
      const terminal = job.attemptCount >= job.maxAttempts;
      await deps.db.query(`update edit_batch_items set state=$2,error=$3,updated_at=now() where id=$1`, [payload.itemId, terminal ? 'FAILED' : 'PREPARING', failure]);
      await syncEditBatchForItem(deps.db, payload.itemId);
      throw error;
    }
  };
}

export function createEditExportJobHandler(deps: VideoHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, _attemptId, signal) => {
    if (job.type !== 'EDIT_EXPORT') throw new Error('EDIT_EXPORT_JOB_TYPE_INVALID');
    if (signal.aborted) throw new Error('EDIT_EXPORT_CANCELLED');
    const payload = job.payload as { exportId?: string; batchItemId?: string; workspaceId?: string; assetId?: string; outputPath?: string; outputRoot?: string };
    if (!payload.exportId || !payload.batchItemId || !payload.workspaceId || !payload.assetId || !payload.outputPath || !payload.outputRoot) throw new Error('EDIT_EXPORT_PAYLOAD_INVALID');
    await deps.db.query("update edit_exports set status='RUNNING',error=null where id=$1 and status in ('QUEUED','FAILED')", [payload.exportId]);
    const temp = `${payload.outputPath}.${job.id}.part`;
    const lockPath = `${payload.outputPath}.lock`;
    try {
      await authorizedOutputPath(payload.outputPath, payload.outputRoot, deps.localPathAccess);
      if (await stat(payload.outputPath).then(() => true).catch(() => false)) throw new Error('EDIT_EXPORT_DESTINATION_EXISTS');
      await mkdir(lockPath);
      const catalog = new AssetCatalogService(deps.db);
      const asset = await catalog.getReadyWorkspaceAssetContent(payload.workspaceId, payload.assetId);
      if (!asset) throw new Error('EDIT_EXPORT_ASSET_UNAVAILABLE');
      await copyFile(deps.storage.objectPath(asset.storageKey), temp);
      await rename(temp, payload.outputPath);
      await deps.db.query("update edit_exports set status='SUCCEEDED',error=null,finished_at=now() where id=$1", [payload.exportId]);
      await deps.db.query('update edit_batch_items set output_path=$2,updated_at=now() where id=$1', [payload.batchItemId, payload.outputPath]);
      return { exportId: payload.exportId, outputPath: payload.outputPath, status: 'SUCCEEDED' };
    } catch (error) {
      await deps.db.query(`update edit_exports set status=$2,error=$3,finished_at=case when $2='FAILED' then now() else finished_at end where id=$1`, [payload.exportId, job.attemptCount >= job.maxAttempts ? 'FAILED' : 'QUEUED', { code: error instanceof Error ? error.message : 'EDIT_EXPORT_FAILED', message: error instanceof Error ? error.message : '导出失败' }]).catch(() => undefined);
      throw error;
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
      await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export function createVideoLeaseCancellationHandler(video: VideoService, storage: LocalStorageProvider): JobLeaseCancellationHandler {
  return async (job, scope) => {
    if (job.type !== 'VIDEO_RENDER') return false;
    await video.cancelCurrentRender(scope, { code: 'RENDER_CANCELLED', message: 'Worker lease expired after cancellation was requested' });
    const directory = join(storage.root, 'renders');
    const outputName = `${job.id}-${scope.attemptId}.mp4`;
    let names: string[];
    try { names = await readdir(directory); } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return true; throw error; }
    const attemptFiles = names.filter((name) => name === outputName || (name.startsWith(`${outputName}.`) && name.endsWith('.part.mp4')));
    await Promise.all(attemptFiles.map((name) => rm(join(directory, name), { force: true })));
    return true;
  };
}

export function createVideoJobHandler(deps: VideoHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, attemptId, signal) => {
    const payload = job.payload as VideoJobPayload;
    const planned = await deps.video.planJob(job);
    if (planned.renderStatus === 'SUCCEEDED' && planned.outputAssetId) return { manifestId: planned.manifestId, renderId: planned.renderId, outputAssetId: planned.outputAssetId };
    if (!attemptId || job.attemptCount <= 0) throw new Error('Video Render requires a claimed Job attempt');
    const start = await deps.jobs.withCurrentAttemptFence(job.id, attemptId, (scope) => deps.video.startRender(planned.renderId, scope, { seed: planned.manifest.seed }));
    if (!start.executed) return { manifestId: planned.manifestId, renderId: planned.renderId, staleAttempt: true };
    if (!start.value) throw Object.assign(new Error('Current Job attempt could not start its Render'), { code: 'RENDER_START_REJECTED', retryable: true });
    const outputPath = join(deps.storage.root, 'renders', `${job.id}-${attemptId}.mp4`);
    let copiedOutputPath: string | undefined;
    try {
      const rendered = await renderEditManifest({ manifest: planned.manifest, outputPath, ffmpegPath: deps.ffmpegPath, ffprobePath: deps.ffprobePath, signal, ...(deps.fontFile ? { fontFile: deps.fontFile } : {}) });
      if (payload.outputPath && payload.outputRoot) {
        await authorizedOutputPath(payload.outputPath, payload.outputRoot, deps.localPathAccess);
        const destinationExists = await stat(payload.outputPath).then(() => true).catch(() => false);
        if (!destinationExists) {
          const destinationPart = `${payload.outputPath}.${job.id}.part`;
          try { await copyFile(outputPath, destinationPart); await rename(destinationPart, payload.outputPath); copiedOutputPath = payload.outputPath; }
          finally { await rm(destinationPart, { force: true }).catch(() => undefined); }
        } else copiedOutputPath = payload.outputPath;
      }
      const outputInput = { ...(job.projectId ? { projectId: job.projectId } : planned.manifest.workspaceId ? { workspaceId: planned.manifest.workspaceId } : {}), sourcePath: outputPath, kind: 'VIDEO_RENDER', role: 'OUTPUT' as const };
      const preparedOutput = await deps.assets.prepareFile(outputInput);
      const finalized = await deps.jobs.succeedWithCurrentAttempt(job.id, attemptId, async (scope) => {
        const outputAsset = await deps.assets.commitPrepared(outputInput, preparedOutput, scope);
        const completed = await deps.video.completeRender(planned.renderId, scope, outputAsset.id, { durationMs: rendered.durationMs, width: rendered.width, height: rendered.height, format: rendered.format, outputAssetId: outputAsset.id });
        if (!completed) throw Object.assign(new Error('Current Job attempt could not complete its Render'), { code: 'RENDER_FENCE_REJECTED', retryable: true });
        const editorialPlanId = planned.manifest.metadata?.editorialPlanId;
        if (editorialPlanId) await scope.query("update edit_script_plans set status='RENDERED',settings=settings || $2::jsonb,updated_at=now() where id=$1", [editorialPlanId, JSON.stringify(copiedOutputPath ? { outputPath: copiedOutputPath } : {})]);
        const item = await scope.query<{ id: string; batch_id: string }>("update edit_batch_items set state='SUCCEEDED',output_asset_id=$2,error=null,updated_at=now() where job_id=$1 returning id,batch_id", [job.id, outputAsset.id]);
        if (item.rows[0]) {
          const batch = item.rows[0].batch_id;
          const counts = await scope.query<{ expected: number; actual: number; succeeded: number; failed: number; active: number }>(`select b.total_count as expected, count(i.id)::int as actual, count(*) filter (where i.state='SUCCEEDED')::int as succeeded, count(*) filter (where i.state='FAILED')::int as failed, count(*) filter (where i.state in ('QUEUED','PREPARING','RENDERING','RUNNING'))::int as active from edit_batches b left join edit_batch_items i on i.batch_id=b.id where b.id=$1 group by b.total_count`, [batch]);
          const summary = counts.rows[0];
          if (summary) {
            const incomplete = Number(summary.actual) !== Number(summary.expected);
            const status = incomplete ? 'FAILED' : Number(summary.active) > 0 ? 'RUNNING' : Number(summary.failed) > 0 && Number(summary.succeeded) > 0 ? 'PARTIAL' : Number(summary.expected) > 0 && Number(summary.failed) === Number(summary.expected) ? 'FAILED' : 'SUCCEEDED';
            await scope.query('update edit_batches set status=$2,succeeded_count=$3,failed_count=$4,updated_at=now() where id=$1', [batch, status, summary.succeeded, Number(summary.failed) + (incomplete && Number(summary.expected) > Number(summary.actual) ? Number(summary.expected) - Number(summary.actual) : 0)]);
          }
        }
        return { manifestId: planned.manifestId, renderId: planned.renderId, outputAssetId: outputAsset.id, diagnostics: rendered };
      });
      if (finalized.executed) {
        if (deps.localMedia && job.projectId) {
          const mediaIds = planned.manifest.timeline
            .filter((clip) => clip.assetId.startsWith('local-'))
            .map((clip) => clip.assetId);
          if (mediaIds.length > 0) await deps.localMedia.recordUsage({ projectId: job.projectId, manifestId: planned.manifestId, renderId: planned.renderId, mediaIds });
        }
        return finalized.value;
      }
      await deps.jobs.cancelAttempt(job.id, attemptId, async (scope) => { await deps.video.cancelRender(planned.renderId, scope, { code: 'RENDER_CANCELLED', message: 'Cancellation won before final commit' }); });
      return { manifestId: planned.manifestId, renderId: planned.renderId, staleAttempt: true };
    } catch (error) {
      const diagnostics = { code: signal.aborted ? 'RENDER_CANCELLED' : 'RENDER_FAILED', message: error instanceof Error ? error.message : 'unknown' };
      if (signal.aborted) {
        const cancelled = await deps.jobs.cancelAttempt(job.id, attemptId, async (scope) => { await deps.video.cancelRender(planned.renderId, scope, diagnostics); });
        if (cancelled.state === 'CANCELLED') throw error;
      }
      const failedJob = await deps.jobs.fail(job.id, attemptId, diagnostics, true, async (scope) => {
        await deps.video.failRender(planned.renderId, scope, diagnostics);
        const editorialPlanId = planned.manifest.metadata?.editorialPlanId;
        if (editorialPlanId && job.attemptCount >= job.maxAttempts) await scope.query("update edit_script_plans set status='FAILED',updated_at=now() where id=$1", [editorialPlanId]);
        if (job.attemptCount >= job.maxAttempts) {
          const item = await scope.query<{ id: string; batch_id: string }>("update edit_batch_items set state='FAILED',error=$2,updated_at=now() where job_id=$1 returning id,batch_id", [job.id, diagnostics]);
          if (item.rows[0]) {
            const counts = await scope.query<{ expected: number; actual: number; succeeded: number; failed: number; active: number }>(`select b.total_count as expected, count(i.id)::int as actual, count(*) filter (where i.state='SUCCEEDED')::int as succeeded, count(*) filter (where i.state='FAILED')::int as failed, count(*) filter (where i.state in ('QUEUED','PREPARING','RENDERING','RUNNING'))::int as active from edit_batches b left join edit_batch_items i on i.batch_id=b.id where b.id=$1 group by b.total_count`, [item.rows[0].batch_id]);
            const summary = counts.rows[0];
            if (summary) await scope.query('update edit_batches set status=$2,succeeded_count=$3,failed_count=$4,updated_at=now() where id=$1', [item.rows[0].batch_id, Number(summary.active) > 0 ? 'RUNNING' : Number(summary.failed) > 0 && Number(summary.succeeded) > 0 ? 'PARTIAL' : 'FAILED', summary.succeeded, summary.failed]);
          }
        }
      });
      void failedJob;
      throw error;
    } finally { await rm(outputPath, { force: true }); }
  };
}

export function createLocalMediaScanJobHandler(deps: VideoHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, attemptId, signal) => {
    if (job.type !== 'LOCAL_MEDIA_SCAN' || !deps.localMedia) throw new Error('Local media scan service is unavailable');
    const payload = job.payload as { scanId?: string; sourceRoot?: string; recursive?: boolean };
    if (!payload.scanId || !payload.sourceRoot) throw new Error('LOCAL_MEDIA_SCAN_PAYLOAD_INVALID');
    await deps.localMedia.markScanRunning(payload.scanId);
    try {
      const result = await deps.localMedia.scan({ sourceRoot: payload.sourceRoot, recursive: payload.recursive !== false, signal, onProgress: async (progress) => { await deps.jobs.updateProgress(job.id, attemptId, progress); await deps.localMedia!.updateScanProgress(payload.scanId!, progress); } });
      await deps.localMedia.completeScan(payload.scanId, result);
      for (const file of result.files.filter((item) => item.available)) {
        if (signal.aborted) throw new Error('LOCAL_MEDIA_SCAN_CANCELLED');
        try { await deps.localMedia.generateThumbnail(`${result.sourceRootId}:${file.relativePath}`, deps.ffmpegPath); } catch { /* thumbnail failure is recorded and must not hide a usable scan */ }
      }
      return { scanId: payload.scanId, sourceRootId: result.sourceRootId, totalCount: result.totalCount, availableCount: result.availableCount, unavailableCount: result.unavailableCount };
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof Error && error.message === 'LOCAL_MEDIA_SCAN_CANCELLED');
      await deps.localMedia.failScan(payload.scanId, { code: cancelled ? 'LOCAL_MEDIA_SCAN_CANCELLED' : 'LOCAL_MEDIA_SCAN_FAILED', message: error instanceof Error ? error.message : 'scan failed' }, cancelled ? 'CANCELLED' : 'FAILED');
      throw error;
    }
  };
}
