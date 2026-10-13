import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { access as accessFile, copyFile, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import type { Pool } from 'pg';
import { AssetCatalogService, type AssetService, type LocalMediaSourceService } from '../../../packages/modules/asset/src/index.js';
import type { JobAttemptScope, JobLeaseCancellationHandler, JobQueryExecutor, JobRecord, JobService } from '../../../packages/modules/job/src/index.js';
import { ensureStandaloneWorkspace, JianyingDraftImporter, materialSourceFingerprint, planEditorialScript, planEditingWorkbenchItem, prepareVoiceTiming, resolveEditorialPlan, rerollEditorialClip, ScriptEditingV3Service, QwenEmbeddingProvider, QwenVisualAnalysisProvider, VideoAdjustmentService, VideoEditPresetService, HybridMediaService, type EditorialAssetV1, type ExternalVideoProvider, type PlannerAsset, type VideoJobPayload, type VideoService } from '../../../packages/modules/video/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import type { LocalPathAccessService } from '../../../packages/modules/local-path/src/index.js';
import { concatDraftPreviewFragments, generateRepresentativeFrames, muxDraftPreviewAudio, renderDraftPreviewFragment, renderEditManifest } from '../../../packages/infrastructure/ffmpeg/src/index.js';
import type { EditManifestV0 } from '../../../packages/contracts/src/index.js';
import { detectShotsV1 } from '../../../packages/modules/video/src/index.js';
import { redactText } from '../../../packages/logging/src/index.js';

export interface VideoHandlerDeps { db: Pool; storage: LocalStorageProvider; assets: AssetService; jobs: JobService; video: VideoService; ffmpegPath: string; ffprobePath: string; fontFile?: string; localMedia?: LocalMediaSourceService; localPathAccess?: LocalPathAccessService; mediaProvider?: ExternalVideoProvider; }

async function videoOwnerWrite<T>(deps: VideoHandlerDeps, job: JobRecord, attemptId: string, action: (scope: JobAttemptScope) => Promise<T>): Promise<T> {
  const result = await deps.jobs.withCurrentAttemptFence(job.id, attemptId, action);
  if (!result.executed) throw Object.assign(new Error('Video owner attempt is no longer active'), { code: 'VIDEO_OWNER_ATTEMPT_REVOKED', retryable: false });
  return result.value;
}

async function commitVideoOwner<T>(deps: VideoHandlerDeps, job: JobRecord, attemptId: string, action: (scope: JobAttemptScope) => Promise<T>): Promise<T> {
  const result = await deps.jobs.succeedWithCurrentAttempt(job.id, attemptId, action);
  if (!result.executed) throw Object.assign(new Error('Video owner attempt is no longer active'), { code: 'VIDEO_OWNER_ATTEMPT_REVOKED', retryable: false });
  return result.value;
}

async function settleVideoOwnerFailure(deps: VideoHandlerDeps, job: JobRecord, attemptId: string, signal: AbortSignal, error: unknown, fallback: string, action: (scope: JobAttemptScope, diagnostic: { code: string; message: string }, cancelled: boolean, retry: boolean) => Promise<void>): Promise<void> {
  const candidate = error as { code?: unknown; retryable?: unknown };
  const diagnostic = { code: typeof candidate.code === 'string' ? redactText(candidate.code) : fallback, message: error instanceof Error ? redactText(error.message).slice(0, 500) : fallback };
  const current = await deps.jobs.get(job.id);
  if (current?.state === 'CANCEL_REQUESTED') { await deps.jobs.cancelAttempt(job.id, attemptId, (scope) => action(scope, diagnostic, true, false)); return; }
  const retryable = typeof candidate.retryable === 'boolean' ? candidate.retryable : true;
  const failed = await deps.jobs.fail(job.id, attemptId, diagnostic, retryable, (scope) => action(scope, diagnostic, false, retryable && job.attemptCount < job.maxAttempts));
  if (failed.state === 'CANCEL_REQUESTED') await deps.jobs.cancelAttempt(job.id, attemptId, (scope) => action(scope, diagnostic, true, false));
}

export function createDraftPreviewJobHandler(deps: VideoHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, _attemptId, signal) => {
    if (job.type !== 'EDIT_V3_DRAFT_PREVIEW') throw new Error('DRAFT_PREVIEW_JOB_TYPE_INVALID');
    const payload = job.payload as { sessionId?: string; manifestId?: string; snapshotId?: string; workspaceId?: string; mode?: 'DRAFT' | 'FAST' };
    if (!payload.sessionId || !payload.manifestId || !payload.snapshotId || !payload.workspaceId || !payload.mode) throw new Error('DRAFT_PREVIEW_PAYLOAD_INVALID');
    const row = (await deps.db.query('select manifest from edit_manifests where id=$1 and workspace_id=$2', [payload.manifestId, payload.workspaceId])).rows[0] as { manifest?: EditManifestV0 } | undefined;
    if (!row?.manifest) throw new Error('DRAFT_PREVIEW_MANIFEST_NOT_FOUND');
    const manifest = row.manifest;
    const clips = manifest.timeline.filter((clip) => clip.role !== 'INTRO' && clip.role !== 'OUTRO');
    if (!clips.length) throw new Error('DRAFT_PREVIEW_NO_FRAGMENTS');
    const assetIds = [...new Set(clips.map((clip) => clip.assetId))];
    const assetRows = await deps.db.query<{ asset_id: string; source_fingerprint: string | null; source_path: string }>('select asset_id,source_fingerprint,source_path from material_pool_items where snapshot_id=$1 and asset_id=any($2::text[])', [payload.snapshotId, assetIds]);
    const assetFingerprints = new Map(assetRows.rows.map((item) => [item.asset_id, item.source_fingerprint]));
    const previewRoot = `${deps.storage.root}/script-editing-v3/previews/${payload.sessionId}/${payload.mode.toLowerCase()}`;
    const fragmentRoot = `${previewRoot}/fragments`;
    const fragmentPaths: string[] = [];
    let renderedFragmentCount = 0;
    let reusedFragmentCount = 0;
    let changedClipCount = 0;
    let cursor = 0;
    const startedAt = Date.now();
    for (const [index, clip] of clips.entries()) {
      signal.throwIfAborted();
      const visualStart = clip.timelineStartMs ?? cursor;
      const visualDurationMs = Math.max(clip.durationMs, (clip.timelineEndMs ?? visualStart + clip.durationMs) - visualStart);
      cursor = visualStart + visualDurationMs;
      const sourceOutMs = clip.sourceOutMs ?? clip.sourceInMs + clip.durationMs;
      const fingerprint = assetFingerprints.get(clip.assetId) || `${clip.sourcePath}:${clip.sourceInMs}:${sourceOutMs}`;
      const fragmentKey = `${payload.mode.toLowerCase()}-${index}-${clip.sentenceId || clip.assetId}`;
      const cached = (await deps.db.query<{ output_path: string }>('select output_path from script_editing_v3_preview_fragments where workspace_id=$1 and fragment_key=$2 and source_fingerprint=$3 and source_in_ms=$4 and source_out_ms=$5 and status=\'READY\' and output_path is not null order by updated_at desc limit 1', [payload.workspaceId, fragmentKey, fingerprint, clip.sourceInMs, sourceOutMs])).rows[0];
      let fragmentPath = cached?.output_path || `${fragmentRoot}/${index}-${Buffer.from(`${fingerprint}:${clip.sourceInMs}:${sourceOutMs}`).toString('base64url').slice(0, 32)}.mp4`;
      if (cached?.output_path && await accessFile(cached.output_path).then(() => true).catch(() => false)) reusedFragmentCount += 1;
      else {
        changedClipCount += 1;
        const localSubtitles = deps.fontFile ? (manifest.subtitles || []).filter((item) => item.endMs > visualStart && item.startMs < visualStart + visualDurationMs).map((item) => ({ ...item, startMs: Math.max(0, item.startMs - visualStart), endMs: Math.min(visualDurationMs, item.endMs - visualStart) })) : undefined;
        const localOverlays = deps.fontFile ? (manifest.textOverlays || []).filter((item) => item.endMs > visualStart && item.startMs < visualStart + visualDurationMs).map((item) => ({ ...item, startMs: Math.max(0, item.startMs - visualStart), endMs: Math.min(visualDurationMs, item.endMs - visualStart) })) : undefined;
        await renderDraftPreviewFragment({ inputPath: clip.sourcePath, outputPath: fragmentPath, sourceInMs: clip.sourceInMs, sourceOutMs, visualDurationMs, canvas: manifest.canvas, ...(localSubtitles?.length ? { subtitles: localSubtitles } : {}), ...(manifest.subtitleStyle ? { subtitleStyle: manifest.subtitleStyle } : {}), ...(localOverlays?.length ? { textOverlays: localOverlays } : {}), ffmpegPath: deps.ffmpegPath, ffprobePath: deps.ffprobePath, ...(deps.fontFile ? { fontFile: deps.fontFile } : {}), signal });
        renderedFragmentCount += 1;
      }
      await deps.db.query("insert into script_editing_v3_preview_fragments (id,workspace_id,manifest_id,fragment_key,source_fingerprint,source_in_ms,source_out_ms,output_path,status,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8,'READY',$9) on conflict (manifest_id,fragment_key,source_fingerprint,source_in_ms,source_out_ms) do update set output_path=excluded.output_path,status='READY',metadata=excluded.metadata,updated_at=now()", [`preview-fragment-${randomUUID()}`, payload.workspaceId, payload.manifestId, fragmentKey, fingerprint, clip.sourceInMs, sourceOutMs, fragmentPath, { mode: payload.mode, sentenceId: clip.sentenceId || null }]);
      fragmentPaths.push(fragmentPath);
    }
    const concatStartedAt = Date.now();
    const concatPath = `${previewRoot}/concat.mp4`;
    await concatDraftPreviewFragments({ fragmentPaths, outputPath: concatPath, ffmpegPath: deps.ffmpegPath, ffprobePath: deps.ffprobePath, signal });
    let outputPath = concatPath;
    if (manifest.audio.voicePath && await accessFile(manifest.audio.voicePath).then(() => true).catch(() => false)) {
      outputPath = `${previewRoot}/draft-preview.mp4`;
      await muxDraftPreviewAudio({ videoPath: concatPath, audioPath: manifest.audio.voicePath, outputPath, durationMs: fragmentPaths.length ? cursor : 0, ffmpegPath: deps.ffmpegPath, ffprobePath: deps.ffprobePath, signal });
    }
    const metrics = { draftPreviewTotalMs: Date.now() - startedAt, changedClipCount, reusedFragmentCount, renderedFragmentCount, concatMs: Date.now() - concatStartedAt };
    await deps.db.query("insert into script_editing_v3_preview_fragments (id,workspace_id,manifest_id,fragment_key,source_fingerprint,source_in_ms,source_out_ms,output_path,status,metadata) values ($1,$2,$3,$4,$5,0,1,$6,'READY',$7) on conflict (manifest_id,fragment_key,source_fingerprint,source_in_ms,source_out_ms) do update set output_path=excluded.output_path,status='READY',metadata=excluded.metadata,updated_at=now()", [`preview-output-${randomUUID()}`, payload.workspaceId, payload.manifestId, `__concat__-${payload.mode.toLowerCase()}`, `${payload.manifestId}:${payload.mode}`, outputPath, metrics]);
    console.log(JSON.stringify({ level: 'info', event: 'script_editing_v3.draft_preview', sessionId: payload.sessionId, manifestId: payload.manifestId, mode: payload.mode, ...metrics }));
    return { mode: payload.mode, manifestId: payload.manifestId, outputPath, ...metrics };
  };
}

export function createVisualAnalysisJobHandler(deps: VideoHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, attemptId, signal) => {
    if (job.type !== 'ANALYZE_ASSET_VISUAL' && job.type !== 'GENERATE_REPRESENTATIVE_FRAMES') throw new Error('ANALYZE_ASSET_VISUAL_JOB_TYPE_INVALID');
    if (signal.aborted) throw new Error('ANALYZE_ASSET_VISUAL_CANCELLED');
    const payload = job.payload as { snapshotId?: string; assetId?: string; analysisConfig?: string };
    if (!payload.snapshotId || !payload.assetId) throw new Error('ANALYZE_ASSET_VISUAL_PAYLOAD_INVALID');
    const snapshotId = payload.snapshotId; const assetId = payload.assetId;
    const v3Service = new ScriptEditingV3Service(deps.db);
    const source = await v3Service.readVisualJobSource(deps.db, job, snapshotId, assetId);
    const fingerprint = source.fingerprint;
    const write = async <T>(action: (scope: JobAttemptScope) => Promise<T>): Promise<T> => {
      const result = await deps.jobs.withCurrentAttemptFence(job.id, attemptId, async (scope) => {
        await v3Service.readVisualJobSource(scope, job, snapshotId, assetId, fingerprint);
        return action(scope);
      });
      if (!result.executed) throw Object.assign(new Error('VISUAL_JOB_ATTEMPT_REVOKED'), { retryable: false });
      return result.value;
    };
    const modelName = process.env.QWEN_VL_MODEL || process.env.QWEN_MODEL || 'qwen-vl-max';
    const modelVersion = process.env.QWEN_MODEL_VERSION || 'unknown';
    let existingProfile = (await deps.db.query<{ status: string; model_name: string; model_version: string; prompt_version: string; analysis_version: string; source_fingerprint?: string | null; profile: Record<string, unknown> }>('select status,model_name,model_version,prompt_version,analysis_version,source_fingerprint,profile from asset_visual_profiles where asset_id=$1', [payload.assetId])).rows[0];
    const analysisConfig = `${modelName}:${modelVersion}:qwen-visual-v2:asset-profile-v2`;
    if (payload.analysisConfig && payload.analysisConfig !== analysisConfig) throw Object.assign(new Error('VISUAL_JOB_CONFIG_CHANGED'), { retryable: false });
    let profileCacheValid = existingProfile?.status === 'READY' && existingProfile.source_fingerprint === fingerprint && existingProfile.model_name === modelName && existingProfile.model_version === modelVersion && existingProfile.prompt_version === 'qwen-visual-v2' && existingProfile.analysis_version === 'asset-profile-v2';
    const frameGenerationVersion = 'representative-frames-v1';
    const existing = await deps.db.query<{ frame_index: number; timestamp_ms: number; frame_key: string }>('select frame_index,timestamp_ms,frame_key from asset_representative_frames where asset_id=$1 and source_fingerprint=$2 and frame_generation_version=$3 order by frame_index', [payload.assetId, fingerprint, frameGenerationVersion]);
    const safeAssetId = payload.assetId.replace(/[^a-zA-Z0-9._-]/gu, '_');
    const safeFingerprint = Buffer.from(fingerprint).toString('base64url');
    const safeJobId = job.id.replace(/[^a-zA-Z0-9._-]/gu, '_');
    const frameDirectory = join(deps.storage.root, 'representative-frames', frameGenerationVersion, safeAssetId, safeFingerprint, safeJobId, attemptId);
    const cachedFrames = existing.rows.length === 5 && existing.rows.every((frame) => frame.frame_key) ? existing.rows.map((frame) => ({ index: Number(frame.frame_index), timestampMs: Number(frame.timestamp_ms), path: `${deps.storage.root}/representative-frames/${frame.frame_key}` })) : [];
    try {
      if (job.type === 'ANALYZE_ASSET_VISUAL' && !profileCacheValid) {
        const cachedProfile = await write((scope) => v3Service.beginVisualAttempt(scope, job, assetId, fingerprint, modelName, modelVersion));
        if (cachedProfile) { existingProfile = { status: 'READY', model_name: modelName, model_version: modelVersion, prompt_version: 'qwen-visual-v2', analysis_version: 'asset-profile-v2', source_fingerprint: fingerprint, profile: cachedProfile }; profileCacheValid = true; }
      }
      const generatedFrames = cachedFrames.length === 5 && (await Promise.all(cachedFrames.map((frame) => accessFile(frame.path).then(() => true).catch(() => false))).then((available) => available.every(Boolean))) ? cachedFrames : await generateRepresentativeFrames(source.sourcePath, frameDirectory, source.durationMs, deps.ffmpegPath, signal);
      if (cachedFrames.length !== 5 || generatedFrames.some((frame) => !cachedFrames.some((cached) => cached.path === frame.path))) {
        await write((scope) => v3Service.persistRepresentativeFrames(scope, { assetId, fingerprint, version: frameGenerationVersion, frames: generatedFrames.map((frame) => ({ index: frame.index, timestampMs: frame.timestampMs, frameKey: relative(join(deps.storage.root, 'representative-frames'), frame.path).replaceAll('\\', '/') })) }));
      }
      if (job.type === 'GENERATE_REPRESENTATIVE_FRAMES') return { assetId, status: 'READY', frameCount: generatedFrames.length };
      if (profileCacheValid) {
        const embeddingModel = process.env.QWEN_EMBEDDING_MODEL || 'text-embedding-v3';
        const embedding = (await deps.db.query<{ asset_id: string; source_fingerprint: string; model_name: string }>('select asset_id,source_fingerprint,model_name from asset_semantic_embeddings where asset_id=$1', [payload.assetId])).rows[0];
        const embeddingReady = embedding?.source_fingerprint === fingerprint && embedding.model_name === embeddingModel;
        if (!embeddingReady && (process.env.QWEN_BASE_URL || process.env.QWEN_API_URL) && process.env.QWEN_API_KEY) {
          const cachedProfile = existingProfile!.profile;
          const embeddingResult = await new QwenEmbeddingProvider().embed({ texts: [`${String(cachedProfile.summary || '')} ${Array.isArray(cachedProfile.tags) ? cachedProfile.tags.map((tag) => tag && typeof tag === 'object' ? String((tag as Record<string, unknown>).tag || '') : '').join(' ') : ''}`], signal });
          await write(async (scope) => { await v3Service.assertReadyVisualProfile(scope, assetId, fingerprint, cachedProfile); await v3Service.persistSemanticEmbedding({ assetId, sourceFingerprint: fingerprint, provider: embeddingResult.provider, model: embeddingResult.model, vector: embeddingResult.vectors[0]! }, scope); });
        }
        return { assetId: payload.assetId, status: 'READY', cached: true, profile: existingProfile!.profile };
      }
      const profile = await new QwenVisualAnalysisProvider({ model: modelName, modelVersion }).analyzeAssetFrames({ assetId: payload.assetId, framePaths: generatedFrames.map((frame) => frame.path), frameTimestampsMs: generatedFrames.map((frame) => frame.timestampMs), signal });
      await write(async (scope) => { await v3Service.assertPendingVisualOwner(scope, job, assetId, fingerprint, analysisConfig); await v3Service.persistVisualProfile(profile, fingerprint, scope); });
      if ((process.env.QWEN_BASE_URL || process.env.QWEN_API_URL) && process.env.QWEN_API_KEY) {
        try {
          const embedding = await new QwenEmbeddingProvider().embed({ texts: [`${profile.summary} ${profile.tags.map((tag) => tag.tag).join(' ')}`], signal });
          await write(async (scope) => { await v3Service.assertReadyVisualProfile(scope, assetId, fingerprint, profile); await v3Service.persistSemanticEmbedding({ assetId, sourceFingerprint: fingerprint, provider: embedding.provider, model: embedding.model, vector: embedding.vectors[0]! }, scope); });
        } catch { /* Embeddings are an optimization; lexical retrieval remains available. */ }
      }
      return { assetId: payload.assetId, status: 'READY', profile };
    } catch (error) {
      if (job.type === 'ANALYZE_ASSET_VISUAL' && job.attemptCount >= job.maxAttempts) {
        const diagnostic = { code: 'ANALYZE_ASSET_VISUAL_FAILED', message: 'Visual analysis failed before its current attempt completed' };
        await deps.jobs.fail(job.id, attemptId, diagnostic, true, async (scope) => {
          try { await v3Service.failPendingVisualAttempt(scope, job, assetId, fingerprint, analysisConfig, diagnostic); }
          catch (ownerError) { if (!(ownerError instanceof Error) || ownerError.message !== 'VISUAL_JOB_OWNER_REVOKED') throw ownerError; }
        });
      }
      throw error;
    }
  };
}

export function createJianyingImportJobHandler(deps: VideoHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, _attemptId, signal) => {
    if (job.type !== 'IMPORT_JIANYING_DRAFT') throw new Error('IMPORT_JIANYING_DRAFT_JOB_TYPE_INVALID');
    if (signal.aborted) throw new Error('IMPORT_JIANYING_DRAFT_CANCELLED');
    const payload = job.payload as { workspaceId?: string; draftPaths?: string[] };
    if (!payload.workspaceId || !Array.isArray(payload.draftPaths) || !payload.draftPaths.length) throw new Error('IMPORT_JIANYING_DRAFT_PAYLOAD_INVALID');
    await ensureStandaloneWorkspace(deps.db, payload.workspaceId);
    const importer = new JianyingDraftImporter(deps.db);
    const imports = [];
    for (const draftPath of [...new Set(payload.draftPaths)]) {
      if (signal.aborted) throw new Error('IMPORT_JIANYING_DRAFT_CANCELLED');
      imports.push(await importer.importReadOnly(payload.workspaceId, draftPath));
    }
    return { imports, usageCount: imports.reduce((total, item) => total + item.usageCount, 0) };
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
  return async (job, attemptId, signal) => {
    const payload = job.payload as { planId?: string; operation?: string; clipId?: string; localOnly?: boolean };
    const planId = payload.planId;
    const guard = async (scope: JobAttemptScope): Promise<void> => {
      const linked = await scope.query("select id from edit_script_plans where id::text=$1 and job_id=$2 and workspace_id=$3 for update", [planId || '', job.id, job.workspaceId || (job.projectId ? `workspace-project-${job.projectId}` : null)]);
      if (!linked.rowCount) throw Object.assign(new Error('Script plan does not match its Job owner'), { code: 'EDIT_SCRIPT_PLAN_OWNER_JOB_MISMATCH', retryable: false });
    };
    const write = <T>(action: (scope: JobAttemptScope) => Promise<T>) => videoOwnerWrite(deps, job, attemptId, async (scope) => { await guard(scope); return action(scope); });
    const finish = (action: (scope: JobAttemptScope) => Promise<void>) => commitVideoOwner(deps, job, attemptId, async (scope) => { await guard(scope); await action(scope); return { planId, status: 'READY', ...(payload.operation === 'REROLL_CLIP' ? { operation: 'REROLL_CLIP' } : {}) }; });
    try {
    if (job.type !== 'EDIT_SCRIPT_PLAN') throw new Error('EDIT_SCRIPT_PLAN_JOB_TYPE_INVALID');
    if (signal.aborted) throw new Error('EDIT_SCRIPT_PLAN_CANCELLED');
    if (!planId) throw new Error('EDIT_SCRIPT_PLAN_PAYLOAD_INVALID');
    const row = (await deps.db.query('select id, resolved_plan, editorial_plan, settings, source_roots, script, voice_asset_id from edit_script_plans where id=$1', [planId])).rows[0] as { id: string; resolved_plan: unknown; editorial_plan: unknown; settings: Record<string, unknown>; source_roots: unknown; script: string; voice_asset_id?: string | null } | undefined;
    if (!row) throw new Error('EDIT_SCRIPT_PLAN_NOT_FOUND');
    await write((scope) => scope.query("update edit_script_plans set status='PLANNING',updated_at=now() where id=$1", [planId]));
    if (payload.operation === 'REROLL_CLIP') {
      if (!row.resolved_plan) throw new Error('SCRIPT_PLAN_NOT_READY');
      const assets = Array.isArray(row.settings?.assets) ? row.settings.assets as EditorialAssetV1[] : [];
      const priorityAssets = Array.isArray(row.settings?.priorityAssets) ? row.settings.priorityAssets as Array<{ assetId: string; mode: 'PREFER' | 'MUST_USE'; path?: string }> : [];
      let rerolled = row.resolved_plan as import('../../../packages/modules/video/src/index.js').ResolvedEditorialPlanV1;
      const options = { localOnly: payload.localOnly === true, priorityAssets, allowControlledReuse: true, seed: Number(row.settings?.seed || 1) };
      if (payload.clipId) rerolled = rerollEditorialClip(rerolled, assets, payload.clipId, options);
      else for (const slot of rerolled.scenes.flatMap((scene) => scene.clipSlots).filter((candidate) => !candidate.locked)) rerolled = rerollEditorialClip(rerolled, assets, slot.id, options);
      return await finish(async (scope) => { await scope.query("update edit_script_plans set resolved_plan=$2,settings=settings - 'pendingReroll',status='READY',updated_at=now() where id=$1", [planId, rerolled]); });
    }
    let editorial = row.editorial_plan as import('../../../packages/modules/video/src/index.js').EditorialPlanV1 | null;
    if (editorial) {
      const voicePath = typeof row.settings?.voicePath === 'string' ? await authorizedVoicePath(row.settings.voicePath, deps.localPathAccess) : undefined;
      const hasExplicitVoiceTiming = editorial.sentences.length > 0 && editorial.sentences.every((sentence) => sentence.voiceStartMs !== undefined && sentence.voiceEndMs !== undefined);
      const voiceTiming = await prepareVoiceTiming({ assetService: deps.assets, assets: new AssetCatalogService(deps.db) }, { workspaceId: job.workspaceId || 'workspace-local', script: row.script, ...(hasExplicitVoiceTiming ? { sentences: editorial.sentences } : {}), ...(row.voice_asset_id ? { voiceAssetId: String(row.voice_asset_id) } : {}), ...(voicePath ? { voicePath } : {}) });
      if (voiceTiming.voiceAssetId && voiceTiming.voiceAssetId !== row.voice_asset_id) {
        await write((scope) => scope.query('update edit_script_plans set voice_asset_id=$2 where id=$1', [planId, voiceTiming.voiceAssetId]));
      }
      if (voiceTiming.sentences.length && JSON.stringify(voiceTiming.sentences) !== JSON.stringify(editorial.sentences)) {
        editorial = planEditorialScript({ sentences: voiceTiming.sentences, template: editorial.templateId, pace: editorial.pace, shotDensity: editorial.shotDensity, subtitleStyle: editorial.subtitlePlan.style, heroText: row.settings?.heroText !== false, ...(Array.isArray(row.settings?.heroTextPolicy) ? { heroTextPolicy: row.settings.heroTextPolicy.filter((value): value is 'HOOK' | 'ENDING' | 'EVIDENCE' => value === 'HOOK' || value === 'ENDING' || value === 'EVIDENCE') } : {}), knownEntities: Array.isArray(row.settings?.knownEntities) ? row.settings.knownEntities.filter((value): value is string => typeof value === 'string') : [], manualKeywords: Array.isArray(row.settings?.manualKeywords) ? row.settings.manualKeywords.filter((value): value is string => typeof value === 'string') : [], audioPlan: editorial.audioPlan, brandingPlan: editorial.brandingPlan });
        await write((scope) => scope.query('update edit_script_plans set editorial_plan=$2,resolved_plan=null where id=$1', [planId, editorial]));
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
          const registration = await deps.localMedia.prepareScanRegistration({ id: scanId, workspaceId: job.workspaceId || 'workspace-local', sourceRoot: root, recursive: true });
          const scan = await deps.localMedia.scan({ sourceRoot: root, recursive: true, signal });
          const preparedScan = await deps.localMedia.prepareScanResult(scan);
          await write(async (scope) => { await deps.localMedia!.createPreparedScan(registration, scope); await deps.localMedia!.markScanRunning(scanId, scope); await deps.localMedia!.completePreparedScan(scanId, preparedScan, scope); });
          for (const file of scan.files.filter((item) => item.available)) {
            if (signal.aborted) throw new Error('EDIT_SCRIPT_PLAN_CANCELLED');
            try { await deps.localMedia.generateThumbnail(`${scan.sourceRootId}:${file.relativePath}`, deps.ffmpegPath); } catch (error) { console.error(JSON.stringify({ level: 'error', event: 'local_media.thumbnail_failed', code: 'THUMBNAIL_GENERATION_FAILED', fileId: `${scan.sourceRootId}:${file.relativePath}`, message: error instanceof Error ? error.message.slice(0, 500) : 'thumbnail generation failed' })); }
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
      return await finish(async (scope) => { await scope.query("update edit_script_plans set resolved_plan=$2,settings=settings || $3::jsonb,status='READY',updated_at=now() where id=$1", [planId, resolved, JSON.stringify({ assets: scannedAssets })]); });
    }
    if (!row.resolved_plan) throw new Error('EDIT_SCRIPT_PLAN_NO_RESOLVED_MEDIA');
    let existingPlan = row.resolved_plan as { audioPlan?: { backgroundMusicMode?: string; path?: string; category?: string; [key: string]: unknown }; warnings?: string[] };
    if (existingPlan.audioPlan?.backgroundMusicMode === 'AUTO' && !existingPlan.audioPlan.path) { const musicPath = await chooseLocalMusic(existingPlan.audioPlan.category, Number(row.settings.seed || 1)); existingPlan = musicPath ? { ...existingPlan, audioPlan: { ...existingPlan.audioPlan, path: musicPath } } : { ...existingPlan, warnings: [...(existingPlan.warnings || []), 'EDIT_BGM_UNAVAILABLE'] }; }
    return await finish(async (scope) => { await scope.query("update edit_script_plans set resolved_plan=$2,status='READY',updated_at=now() where id=$1", [planId, existingPlan]); });
    } catch (error) {
      await settleVideoOwnerFailure(deps, job, attemptId, signal, error, 'EDIT_SCRIPT_PLAN_FAILED', async (scope, _diagnostic, _cancelled, retry) => { await guard(scope); await scope.query("update edit_script_plans set status=$2,updated_at=now() where id=$1 and status in ('QUEUED','PLANNING')", [planId || '', retry ? 'QUEUED' : 'FAILED']); });
      throw error;
    }
  };
}

async function syncEditBatch(db: JobQueryExecutor, batchId: string): Promise<void> {
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

async function syncEditBatchForItem(db: JobQueryExecutor, itemId: string): Promise<void> {
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
  return async (job, attemptId, signal) => {
    if (job.type !== 'EDIT_PREPARE_ITEM') throw new Error('EDIT_PREPARE_JOB_TYPE_INVALID');
    if (signal.aborted) throw new Error('EDIT_PREPARE_CANCELLED');
    const payload = job.payload as { batchId?: string; itemId?: string; workspaceId?: string };
    if (!payload.batchId || !payload.itemId || !payload.workspaceId) throw new Error('EDIT_PREPARE_PAYLOAD_INVALID');
    const row = (await deps.db.query('select i.*, b.mode, s.settings from edit_batch_items i join edit_batches b on b.id = i.batch_id join edit_workbench_sessions s on s.id = b.session_id where i.id=$1 and i.batch_id=$2 and i.workspace_id=$3', [payload.itemId, payload.batchId, payload.workspaceId])).rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error('EDIT_PREPARE_ITEM_NOT_FOUND');
    const write = async (text: string, values: unknown[]) => {
      const result = await deps.jobs.withCurrentAttemptFence(job.id, attemptId, (scope) => scope.query(text, values));
      if (!result.executed) throw Object.assign(new Error('Edit preparation attempt is no longer active'), { code: 'STALE_ATTEMPT', retryable: false });
      return result.value;
    };
    const started = await write("update edit_batch_items set state='PREPARING',error=null,updated_at=now() where id=$1 and batch_id=$2 and workspace_id=$3 and prepare_job_id=$4 and state in ('QUEUED','PREPARING','FAILED') returning id", [payload.itemId, payload.batchId, payload.workspaceId, job.id]);
    if (!started.rowCount) throw new Error('EDIT_PREPARE_OWNER_JOB_MISMATCH');
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
        await write("update edit_batch_items set settings_snapshot=settings_snapshot || $2::jsonb,updated_at=now() where id=$1 and prepare_job_id=$3 and state='PREPARING'", [payload.itemId, JSON.stringify({ phase: 'VISUAL_PLANNING' }), job.id]);
        await write("update edit_batch_items set settings_snapshot=settings_snapshot || $2::jsonb,updated_at=now() where id=$1 and prepare_job_id=$3 and state='PREPARING'", [payload.itemId, JSON.stringify({ phase: 'LOCAL_MATCHING' }), job.id]);
        const hybrid = await new HybridMediaService(deps.assets, deps.storage, deps.mediaProvider, deps.db).resolve({ workspaceId: payload.workspaceId, script: String(row.script), sentences: voiceTiming.sentences, localAssets: scanAssets as Array<PlannerAsset & { originalName?: string; tags?: string[]; metadata?: Record<string, unknown> }>, usePexels: true, minClipDurationMs: Number(itemSettings.minClipDurationMs || 2_000), maxClipDurationMs: Number(itemSettings.maxClipDurationMs || 5_000), signal });
        plannedAssets = hybrid.assets;
        hybridDiagnostics = { ...hybrid.diagnostics, visualPlan: hybrid.plan, resolvedVisualPlan: hybrid.resolvedPlan, resolvedAssignments: hybrid.resolvedAssignments };
        await write("update edit_batch_items set settings_snapshot=settings_snapshot || $2::jsonb,updated_at=now() where id=$1 and prepare_job_id=$3 and state='PREPARING'", [payload.itemId, JSON.stringify({ phase: 'MANIFEST_BUILDING', hybridDiagnostics }), job.id]);
      }
      const quickEdit = new VideoAdjustmentService(deps.db, catalog, deps.localMedia);
      const planned = await planEditingWorkbenchItem({ assetService: deps.assets, assets: catalog, quickEdit, storage: deps.storage, video: deps.video, presets: new VideoEditPresetService(deps.db) }, {
        mode: String(row.mode) as 'SCRIPT' | 'MIX', workspaceId: payload.workspaceId, script: String(row.script), ...(voiceTiming.voiceAssetId ? { voiceAssetId: voiceTiming.voiceAssetId } : {}), sentences: voiceTiming.sentences, assets: plannedAssets, ...(hybridDiagnostics && Array.isArray(hybridDiagnostics.resolvedAssignments) ? { resolvedAssignments: hybridDiagnostics.resolvedAssignments as import('../../../packages/modules/video/src/index.js').ResolvedVisualAssignment[] } : {}), ...((itemSettings.presentationSettings || settings.presentationSettings) ? { presentationSettings: (itemSettings.presentationSettings || settings.presentationSettings) as import('../../../packages/contracts/src/index.js').PresentationSettingsV1 } : {}), seed: Number(itemSettings.seed || 1), minClipDurationMs: Number(itemSettings.minClipDurationMs || 2_000), maxClipDurationMs: Number(itemSettings.maxClipDurationMs || 5_000), preferUnusedMedia: itemSettings.preferUnusedMedia !== false, fps: Number(itemSettings.fps || 30), ...(typeof itemSettings.templateId === 'string' && itemSettings.templateId ? { templateId: itemSettings.templateId } : {}), renderIdempotencySuffix: `edit-item-${payload.itemId}`
      });
      const committed = await deps.jobs.succeedWithCurrentAttempt(job.id, attemptId, async (scope) => {
        const current = await scope.query("select id from edit_batch_items where id=$1 and batch_id=$2 and workspace_id=$3 and prepare_job_id=$4 and job_id is null and state='PREPARING' for update", [payload.itemId, payload.batchId, payload.workspaceId, job.id]);
        if (!current.rowCount) throw new Error('EDIT_PREPARE_OWNER_JOB_MISMATCH');
        const manifest = await quickEdit.createPlannedManifestWithExecutor(scope, { workspaceId: payload.workspaceId!, manifest: planned.manifest, createdBy: 'operator' });
        const renderJob = await deps.video.createManifestRenderJobForWorkspaceWithExecutor(scope, payload.workspaceId!, manifest.id, `edit-item-${payload.itemId}`);
        const result = { ...(planned.voiceAssetId ? { voiceAssetId: planned.voiceAssetId } : {}), manifestId: manifest.id, renderJobId: renderJob.id, renderJobState: renderJob.state };
        await scope.query("update edit_batch_items set voice_asset_id=$2,manifest_id=$3,job_id=$4,state='RENDERING',error=null,settings_snapshot=settings_snapshot || $5::jsonb,updated_at=now() where id=$1 and prepare_job_id=$6", [payload.itemId, result.voiceAssetId || row.voice_asset_id || null, result.manifestId, result.renderJobId, JSON.stringify({ phase: 'RENDERING', ...(hybridDiagnostics ? { hybridDiagnostics } : {}) }), job.id]);
        await syncEditBatchForItem(scope, payload.itemId!);
        return result;
      });
      return committed.executed ? committed.value : { staleAttempt: true };
    } catch (error) {
      const failure = { code: error instanceof Error ? redactText(error.message) : 'EDIT_ITEM_PREPARE_FAILED', message: error instanceof Error ? redactText(error.message) : '编辑任务准备失败' };
      const retryable = (error as { retryable?: unknown }).retryable !== false;
      const terminal = !retryable || job.attemptCount >= job.maxAttempts;
      await deps.jobs.fail(job.id, attemptId, failure, retryable, async (scope) => {
        await scope.query(`update edit_batch_items set state=$2,error=$3,updated_at=now() where id=$1 and prepare_job_id=$4 and workspace_id=$5 and state in ('QUEUED','PREPARING','RUNNING')`, [payload.itemId, terminal ? 'FAILED' : 'PREPARING', failure, job.id, payload.workspaceId]);
        await syncEditBatchForItem(scope, payload.itemId!);
      });
      throw error;
    }
  };
}

export function createEditExportJobHandler(deps: VideoHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, attemptId, signal) => {
    if (job.type !== 'EDIT_EXPORT') throw new Error('EDIT_EXPORT_JOB_TYPE_INVALID');
    if (signal.aborted) throw new Error('EDIT_EXPORT_CANCELLED');
    const payload = job.payload as { exportId?: string; batchItemId?: string; workspaceId?: string; assetId?: string; outputPath?: string; outputRoot?: string };
    if (!payload.exportId || !payload.batchItemId || !payload.workspaceId || !payload.assetId || !payload.outputPath || !payload.outputRoot) throw new Error('EDIT_EXPORT_PAYLOAD_INVALID');
    const guard = async (scope: JobAttemptScope): Promise<void> => {
      const row = await scope.query("select e.id from edit_exports e join edit_batch_items i on i.id=e.batch_item_id where e.id=$1 and e.batch_item_id=$2 and e.job_id=$3 and e.asset_id=$4 and e.output_path=$5 and i.workspace_id=$6 for update of e", [payload.exportId, payload.batchItemId, job.id, payload.assetId, payload.outputPath, job.workspaceId]);
      if (!row.rowCount || payload.workspaceId !== job.workspaceId) throw Object.assign(new Error('Export does not match its Job owner'), { code: 'EDIT_EXPORT_OWNER_JOB_MISMATCH', retryable: false });
    };
    await videoOwnerWrite(deps, job, attemptId, async (scope) => { await guard(scope); const started = await scope.query("update edit_exports set status='RUNNING',error=null where id=$1 and status in ('QUEUED','FAILED') returning id", [payload.exportId]); if (!started.rowCount) throw Object.assign(new Error('Export is no longer pending'), { code: 'EDIT_EXPORT_NOT_ACTIVE', retryable: false }); });
    const temp = `${payload.outputPath}.${job.id}.${attemptId}.part`;
    const lockPath = `${payload.outputPath}.lock`;
    let ownsLock = false;
    try {
      await authorizedOutputPath(payload.outputPath, payload.outputRoot, deps.localPathAccess);
      if (await stat(payload.outputPath).then(() => true).catch(() => false)) throw new Error('EDIT_EXPORT_DESTINATION_EXISTS');
      await mkdir(lockPath);
      ownsLock = true;
      const catalog = new AssetCatalogService(deps.db);
      const asset = await catalog.getReadyWorkspaceAssetContent(payload.workspaceId, payload.assetId);
      if (!asset) throw new Error('EDIT_EXPORT_ASSET_UNAVAILABLE');
      await copyFile(deps.storage.objectPath(asset.storageKey), temp);
      signal.throwIfAborted();
      await videoOwnerWrite(deps, job, attemptId, guard);
      await rename(temp, payload.outputPath);
      return await commitVideoOwner(deps, job, attemptId, async (scope) => {
        await guard(scope);
        const completed = await scope.query("update edit_exports set status='SUCCEEDED',error=null,finished_at=now() where id=$1 and status='RUNNING' returning id", [payload.exportId]);
        if (!completed.rowCount) throw Object.assign(new Error('Export is no longer running'), { code: 'EDIT_EXPORT_NOT_ACTIVE', retryable: false });
        await scope.query('update edit_batch_items set output_path=$2,updated_at=now() where id=$1 and workspace_id=$3', [payload.batchItemId, payload.outputPath, job.workspaceId]);
        return { exportId: payload.exportId, outputPath: payload.outputPath, status: 'SUCCEEDED' };
      });
    } catch (error) {
      await settleVideoOwnerFailure(deps, job, attemptId, signal, error, 'EDIT_EXPORT_FAILED', async (scope, diagnostic, _cancelled, retry) => { await guard(scope); await scope.query("update edit_exports set status=$2,error=$3,finished_at=case when $2='FAILED' then now() else null end where id=$1 and status='RUNNING'", [payload.exportId, retry ? 'QUEUED' : 'FAILED', diagnostic]); });
      throw error;
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
      if (ownsLock) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
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
        const v3SessionId = planned.manifest.metadata?.v3SessionId;
        if (v3SessionId) await scope.query("update script_editing_v3_sessions set status='RENDERED',updated_at=now() where id=$1 and current_manifest_id=$2", [v3SessionId, planned.manifestId]);
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
        const v3SessionId = planned.manifest.metadata?.v3SessionId;
        if (v3SessionId && planned.manifest.workspaceId) {
          for (const assetId of [...new Set(planned.manifest.timeline.map((clip) => clip.assetId))]) {
            const event = await deps.db.query('insert into script_editing_v3_usage_events (id,workspace_id,session_id,manifest_id,render_id,asset_id) values ($1,$2,$3,$4,$5,$6) on conflict (render_id,asset_id) do nothing returning id', [`v3-usage-${randomUUID()}`, planned.manifest.workspaceId, v3SessionId, planned.manifestId, planned.renderId, assetId]);
            if (event.rows[0]) await deps.db.query(`insert into script_editing_v3_asset_usage_stats (workspace_id,asset_id,final_use_count,content_os_final_use_count,recent_use_count,last_used_at) values ($1,$2,1,1,1,now()) on conflict (workspace_id,asset_id) do update set final_use_count=script_editing_v3_asset_usage_stats.final_use_count+1,content_os_final_use_count=script_editing_v3_asset_usage_stats.content_os_final_use_count+1,recent_use_count=script_editing_v3_asset_usage_stats.recent_use_count+1,last_used_at=now(),updated_at=now()`, [planned.manifest.workspaceId, assetId]);
          }
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
        const v3SessionId = planned.manifest.metadata?.v3SessionId;
        if (editorialPlanId && job.attemptCount >= job.maxAttempts) await scope.query("update edit_script_plans set status='FAILED',updated_at=now() where id=$1", [editorialPlanId]);
        if (v3SessionId && job.attemptCount >= job.maxAttempts) await scope.query("update script_editing_v3_sessions set status='FAILED',updated_at=now() where id=$1 and current_manifest_id=$2", [v3SessionId, planned.manifestId]);
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
    const localMedia = deps.localMedia;
    const canonicalRoot = localMedia.prepareScanOwnerRoot(payload.sourceRoot);
    const guard = (scope: JobAttemptScope) => localMedia.assertScanJobLink(scope, job, payload.scanId!, payload.sourceRoot!, canonicalRoot);
    const started = await videoOwnerWrite(deps, job, attemptId, async (scope) => { const current = await guard(scope); await localMedia.markScanRunning(payload.scanId!, scope); return current; });
    try {
      const result = await localMedia.scan({ sourceRoot: canonicalRoot, sourceRootId: started.sourceRootId, recursive: payload.recursive !== false, signal, onProgress: async (progress) => { await deps.jobs.updateProgress(job.id, attemptId, progress); await videoOwnerWrite(deps, job, attemptId, async (scope) => { await guard(scope); await localMedia.updateScanProgress(payload.scanId!, progress, scope); }); } });
      const prepared = await localMedia.prepareScanResult(result);
      const completed = await commitVideoOwner(deps, job, attemptId, async (scope) => { const current = await guard(scope); if (current.status !== 'RUNNING') throw Object.assign(new Error('Local scan is no longer running'), { code: 'LOCAL_MEDIA_SCAN_NOT_ACTIVE', retryable: false }); await localMedia.completePreparedScan(payload.scanId!, prepared, scope); return { scanId: payload.scanId, sourceRootId: result.sourceRootId, totalCount: result.totalCount, availableCount: result.availableCount, unavailableCount: result.unavailableCount }; });
      for (const file of result.files.filter((item) => item.available)) {
        if (signal.aborted) throw new Error('LOCAL_MEDIA_SCAN_CANCELLED');
        try { await deps.localMedia.generateThumbnail(`${result.sourceRootId}:${file.relativePath}`, deps.ffmpegPath); } catch (error) { console.error(JSON.stringify({ level: 'error', event: 'local_media.thumbnail_failed', code: 'THUMBNAIL_GENERATION_FAILED', fileId: `${result.sourceRootId}:${file.relativePath}`, message: error instanceof Error ? error.message.slice(0, 500) : 'thumbnail generation failed' })); }
      }
      return completed;
    } catch (error) {
      await settleVideoOwnerFailure(deps, job, attemptId, signal, error, 'LOCAL_MEDIA_SCAN_FAILED', async (scope, diagnostic, cancelled, retry) => { await guard(scope); await localMedia.failScan(payload.scanId!, diagnostic, retry ? 'QUEUED' : cancelled ? 'CANCELLED' : 'FAILED', scope); });
      throw error;
    }
  };
}

export function createShotDetectionJobHandler(deps: VideoHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, attemptId, signal) => {
    if (job.type !== 'SHOT_DETECTION_V1') throw new Error('SHOT_DETECTION_JOB_TYPE_INVALID');
    const payload = job.payload as { runId?: string; snapshotId?: string; assetId?: string; sourcePath?: string; durationMs?: number; sourceFingerprint?: string; threshold?: number };
    if (!payload.runId || !payload.snapshotId || !payload.assetId || !payload.sourcePath || !payload.durationMs || !payload.sourceFingerprint) throw new Error('SHOT_DETECTION_PAYLOAD_INVALID');
    const selectOwner = async (scope: JobAttemptScope) => { const linked = await scope.query<{ status: string; lease_authority: { jobId?: unknown; attemptId?: unknown; attemptNumber?: unknown } | null }>("select r.status,r.lease_authority from script_editing_v3_shot_detection_runs r join material_pool_snapshots s on s.id=r.snapshot_id where r.id=$1 and r.snapshot_id=$2 and r.asset_id=$3 and r.source_fingerprint=$4 and s.workspace_id=$5 for update of r", [payload.runId, payload.snapshotId, payload.assetId, payload.sourceFingerprint, job.workspaceId]); if (!linked.rows[0]) throw Object.assign(new Error('Shot detection run does not match its Job owner'), { code: 'SHOT_DETECTION_OWNER_JOB_MISMATCH', retryable: false }); return linked.rows[0]; };
    const owns = (scope: JobAttemptScope, row: Awaited<ReturnType<typeof selectOwner>>) => row.status === 'RUNNING' && row.lease_authority?.jobId === job.id && row.lease_authority.attemptId === scope.attemptId && row.lease_authority.attemptNumber === scope.attemptNumber;
    const started = await videoOwnerWrite(deps, job, attemptId, async (scope) => {
      const current = await selectOwner(scope);
      if (current.status === 'SUCCEEDED') return { cached: true };
      if (current.status === 'RUNNING' && (!current.lease_authority || current.lease_authority.jobId !== job.id || typeof current.lease_authority.attemptId !== 'string' || !current.lease_authority.attemptId || !Number.isSafeInteger(current.lease_authority.attemptNumber) || Number(current.lease_authority.attemptNumber) > scope.attemptNumber || (current.lease_authority.attemptNumber === scope.attemptNumber && current.lease_authority.attemptId !== scope.attemptId))) throw Object.assign(new Error('Shot detection run already belongs to another active owner'), { code: 'SHOT_DETECTION_OWNER_BUSY', retryable: false });
      const claimed = await scope.query("update script_editing_v3_shot_detection_runs set status='RUNNING',lease_authority=$2,error=null,threshold=$3,updated_at=now() where id=$1 and status in ('QUEUED','RUNNING','FAILED') returning id", [payload.runId, { jobId: job.id, attemptId: scope.attemptId, attemptNumber: scope.attemptNumber }, payload.threshold ?? 0.35]);
      if (!claimed.rowCount) throw Object.assign(new Error('Shot detection owner cannot be claimed'), { code: 'SHOT_DETECTION_OWNER_BUSY', retryable: false });
      return { cached: false };
    });
    if (started.cached) return commitVideoOwner(deps, job, attemptId, async (scope) => { const current = await selectOwner(scope); if (current.status !== 'SUCCEEDED') throw Object.assign(new Error('Shot detection cache is no longer current'), { code: 'SHOT_DETECTION_OWNER_SUPERSEDED', retryable: false }); const count = await scope.query<{ count: number }>('select count(*)::int as count from script_editing_v3_shots where run_id=$1', [payload.runId]); return { runId: payload.runId, shotCount: Number(count.rows[0]?.count || 0), detectorVersion: 'shot-detection-v1', cached: true }; });
    try {
      const shots = await detectShotsV1({ sourcePath: payload.sourcePath, durationMs: Number(payload.durationMs), ...(payload.threshold === undefined ? {} : { threshold: payload.threshold }), ffmpegPath: deps.ffmpegPath, signal });
      return await commitVideoOwner(deps, job, attemptId, async (scope) => {
        if (!owns(scope, await selectOwner(scope))) throw Object.assign(new Error('Shot detection attempt was superseded by another owner'), { code: 'SHOT_DETECTION_OWNER_SUPERSEDED', retryable: false });
        await scope.query('delete from script_editing_v3_shots where run_id=$1', [payload.runId]);
        for (const [index, shot] of shots.entries()) {
          const shotId = `shot-${randomUUID()}`;
          await scope.query('insert into script_editing_v3_shots (id,run_id,shot_index,source_in_ms,source_out_ms,confidence,evidence) values ($1,$2,$3,$4,$5,$6,$7)', [shotId, payload.runId, index, shot.sourceInMs, shot.sourceOutMs, shot.confidence, shot.evidence]);
          await scope.query('insert into source_segments (id,snapshot_id,asset_id,source_in_ms,source_out_ms,duration_ms,origin,evidence,kind,detection_method,detection_threshold,detector_version) values ($1,$2,$3,$4,$5,$6,\'SHOT_DETECTION\',$7,\'SHOT\',\'FFMPEG_SCENE\',$8,$9) on conflict (snapshot_id,asset_id,source_in_ms,source_out_ms) do update set evidence=excluded.evidence,origin=excluded.origin,kind=excluded.kind,detection_method=excluded.detection_method,detection_threshold=excluded.detection_threshold,detector_version=excluded.detector_version', [shotId, payload.snapshotId, payload.assetId, shot.sourceInMs, shot.sourceOutMs, shot.sourceOutMs - shot.sourceInMs, { runId: payload.runId, confidence: shot.confidence, detectorVersion: 'shot-detection-v1' }, payload.threshold ?? 0.35, 'shot-detection-v1']);
        }
        const completed = await scope.query("update script_editing_v3_shot_detection_runs set status='SUCCEEDED',error=null,updated_at=now() where id=$1 and status='RUNNING' and lease_authority=$2::jsonb returning id", [payload.runId, { jobId: job.id, attemptId: scope.attemptId, attemptNumber: scope.attemptNumber }]);
        if (!completed.rowCount) throw Object.assign(new Error('Shot detection attempt was superseded by another owner'), { code: 'SHOT_DETECTION_OWNER_SUPERSEDED', retryable: false });
        return { runId: payload.runId, shotCount: shots.length, detectorVersion: 'shot-detection-v1' };
      });
    } catch (error) {
      await settleVideoOwnerFailure(deps, job, attemptId, signal, error, 'SHOT_DETECTION_FAILED', async (scope, diagnostic, _cancelled, retry) => { const current = await selectOwner(scope); if (!owns(scope, current)) return; await scope.query("update script_editing_v3_shot_detection_runs set status=$2,error=$3,updated_at=now() where id=$1 and status='RUNNING' and lease_authority=$4::jsonb", [payload.runId, retry ? 'QUEUED' : 'FAILED', diagnostic, { jobId: job.id, attemptId: scope.attemptId, attemptNumber: scope.attemptNumber }]); });
      throw error;
    }
  };
}
