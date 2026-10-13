import { randomUUID } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Pool } from 'pg';
import type { LocalStorageProvider } from '../../../infrastructure/storage/src/index.js';
import type { AssetCatalogService } from '../../asset/src/index.js';
import type { LocalPathAccessService } from '../../local-path/src/index.js';
import { JobService, type JobAttemptScope, type JobLeaseRecoveryContext, type JobQueryExecutor, type JobRecord } from '../../job/src/index.js';
import { buildStoryboardVideoManifest, buildVideoManifest, type PlannerAsset } from './planner.js';
import { validateEditManifest, type EditManifestV0 } from '../../../contracts/src/index.js';
import { digestEditManifest } from './quick-edit.js';
import { materialSourceFingerprint } from './script-editing-v3-service.js';

export interface CreateVideoJobInput { projectId: string; videoAssetIds: string[]; voiceAssetId?: string; targetDurationMs: number; seed: number; subtitleText?: string; idempotencyKey?: string; directorRevisionId?: string; directorRevision?: number; directorBrief?: unknown; directorStoryboard?: unknown; plannerType?: 'RANDOM' | 'STORYBOARD'; storyboardScenes?: Array<{ sceneIndex: number; voiceoverText: string; durationHintSeconds: number; visualInstruction: string; assetKeywords: string[] }>; metadata?: { briefId?: string; scriptRevisionId?: string; storyboardRevisionId?: string }; }
export interface VideoJobPayload extends Omit<CreateVideoJobInput, 'projectId'> { projectId?: string; workspaceId?: string; manifestId?: string; manifestRevision?: number; manifestDigest?: string; outputPath?: string; outputRoot?: string; }
export interface VideoPlanResult { manifestId: string; renderId: string; manifest: ReturnType<typeof buildVideoManifest>; renderStatus: string; outputAssetId: string | null; }

function projectWorkspaceId(projectId: string): string { return `workspace-project-${projectId}`; }
async function authorizedLocalSource(sourcePath: string, pathAccess?: LocalPathAccessService): Promise<boolean> {
  if (pathAccess) { try { await pathAccess.authorize(sourcePath, 'PRIORITY_ASSET'); return true; } catch { return false; } }
  const roots = (process.env.CONTENTOS_LOCAL_MEDIA_ROOTS || '').split(';').map((root) => root.trim()).filter(Boolean).map((root) => resolve(root));
  if (!sourcePath || sourcePath.includes('\0') || roots.length === 0) return false;
  const candidate = await realpath(resolve(sourcePath)).catch(() => null);
  if (!candidate || !(await stat(candidate).then((details) => details.isFile()).catch(() => false))) return false;
  const authorized = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
  return authorized.some((root) => root && (candidate.toLowerCase() === root.toLowerCase() || candidate.toLowerCase().startsWith(`${root}${sep}`.toLowerCase())));
}

export class VideoService {
  private readonly db: Pool;
  private readonly storage: LocalStorageProvider | null;
  private readonly jobs: JobService;
  private readonly assets: AssetCatalogService | null;
  private readonly pathAccess: LocalPathAccessService | undefined;
  constructor(db: Pool, storage: LocalStorageProvider, jobs: JobService, assets?: AssetCatalogService, pathAccess?: LocalPathAccessService);
  constructor(db: Pool, jobs: JobService, assets?: AssetCatalogService, pathAccess?: LocalPathAccessService);
  constructor(db: Pool, storageOrJobs: LocalStorageProvider | JobService, maybeJobs?: JobService | AssetCatalogService, maybeAssets?: AssetCatalogService | LocalPathAccessService, maybePathAccess?: LocalPathAccessService) {
    this.db = db;
    this.storage = maybeJobs && 'create' in maybeJobs ? storageOrJobs as LocalStorageProvider : null;
    this.jobs = (maybeJobs && 'create' in maybeJobs ? maybeJobs : storageOrJobs) as JobService;
    this.assets = (maybeJobs && !('create' in maybeJobs) ? maybeJobs : (maybeAssets && !('authorize' in maybeAssets) ? maybeAssets as AssetCatalogService : undefined)) || null;
    this.pathAccess = (maybeJobs && !('create' in maybeJobs) ? maybeAssets as LocalPathAccessService | undefined : maybePathAccess) || (maybeAssets && 'authorize' in maybeAssets ? maybeAssets as LocalPathAccessService : undefined);
  }

  async ensureProjectWorkspace(projectId: string): Promise<void> {
    await this.db.query("insert into video_workspaces (id, type, project_id) values ($1, 'PROJECT', $2) on conflict (project_id) do nothing", [projectWorkspaceId(projectId), projectId]);
  }

  async createManifestRevision(projectId: string, manifest: EditManifestV0, options: { createdBy?: string; idempotencyKey?: string; forceNewRevision?: boolean } = {}): Promise<{ manifestId: string; revision: number }> {
    return this.withTransaction((executor) => this.createManifestRevisionWithExecutor(executor, projectId, manifest, options));
  }

  async createManifestRevisionWithExecutor(executor: JobQueryExecutor, projectId: string, manifest: EditManifestV0, options: { createdBy?: string; idempotencyKey?: string; forceNewRevision?: boolean } = {}): Promise<{ manifestId: string; revision: number }> {
    if (manifest.projectId !== projectId || manifest.workspaceId) throw new Error('VIDEO_MANIFEST_PROJECT_SCOPE_INVALID');
    validateEditManifest(manifest);
    await executor.query("insert into video_workspaces (id, type, project_id) values ($1, 'PROJECT', $2) on conflict (project_id) do nothing", [projectWorkspaceId(projectId), projectId]);
    await executor.query('select pg_advisory_xact_lock(hashtext($1))', [`contentos:video-manifest:${projectId}`]);
    const planId = manifest.metadata?.intelligentPlanId;
    if (planId && !options.forceNewRevision) {
      const existing = await executor.query<{ id: string; revision: number }>("select id,revision from edit_manifests where project_id=$1 and manifest->'metadata'->>'intelligentPlanId'=$2 order by revision desc limit 1", [projectId, planId]);
      if (existing.rows[0]) return { manifestId: String(existing.rows[0].id), revision: Number(existing.rows[0].revision) };
    }
    await executor.query("update edit_manifests set status='SUPERSEDED' where project_id=$1 and status='PERSISTED'", [projectId]);
    const revision = Number((await executor.query<{ revision: number }>('select coalesce(max(revision),0)+1 as revision from edit_manifests where project_id=$1', [projectId])).rows[0]?.revision || 1);
    const manifestId = `manifest-${randomUUID()}`;
    await executor.query('insert into edit_manifests (id,project_id,workspace_id,revision,schema_version,manifest,manifest_digest,status,created_by,idempotency_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [manifestId, projectId, projectWorkspaceId(projectId), revision, 'EDIT_MANIFEST_V0', manifest, digestEditManifest(manifest), 'PERSISTED', options.createdBy || 'intelligent-planner', options.idempotencyKey || null]);
    return { manifestId, revision };
  }

  async createJob(input: CreateVideoJobInput): Promise<JobRecord> {
    if (input.videoAssetIds.length === 0) throw new Error('At least one video asset is required');
    await this.ensureProjectWorkspace(input.projectId);
    const idempotencyKey = input.idempotencyKey || `video-render:${input.projectId}:${input.seed}:${input.targetDurationMs}:${input.videoAssetIds.join(',')}`;
    const id = `job-${randomUUID()}`;
    try { return await this.jobs.create({ id, projectId: input.projectId, workspaceId: projectWorkspaceId(input.projectId), type: 'VIDEO_RENDER', payload: input, idempotencyKey, maxAttempts: 3 }); }
    catch (error) { if ((error as { code?: string }).code === '23505') { const existing = await this.jobs.getByIdempotencyKey(idempotencyKey); if (existing) return existing; } throw error; }
  }

  async createManifestRenderJob(projectId: string, manifestId: string): Promise<JobRecord> {
    return this.withTransaction((executor) => this.createManifestRenderJobWithExecutor(executor, projectId, manifestId));
  }

  async createManifestRenderJobWithExecutor(executor: JobQueryExecutor, projectId: string, manifestId: string): Promise<JobRecord> {
    await executor.query("insert into video_workspaces (id, type, project_id) values ($1, 'PROJECT', $2) on conflict (project_id) do nothing", [projectWorkspaceId(projectId), projectId]);
    const manifest = await executor.query<{ revision: number; project_id: string; manifest: EditManifestV0; manifest_digest: string | null }>('select revision, project_id, manifest, manifest_digest from edit_manifests where id = $1 and project_id = $2', [manifestId, projectId]);
    const row = manifest.rows[0];
    if (!row) throw new Error('VIDEO_MANIFEST_NOT_FOUND');
    const manifestRevision = Number(row.revision);
    const manifestDigest = digestEditManifest(row.manifest);
    if (row.manifest_digest && row.manifest_digest !== manifestDigest) throw new Error('VIDEO_MANIFEST_DIGEST_CONFLICT');
    if (!row.manifest_digest) await executor.query('update edit_manifests set manifest_digest = $2 where id = $1 and manifest_digest is null', [manifestId, manifestDigest]);
    const idempotencyKey = `video-render:manifest:${projectId}:${manifestId}:v${manifestRevision}`;
    return this.jobs.createIdempotentWithExecutor(executor, { id: `job-${randomUUID()}`, projectId, workspaceId: projectWorkspaceId(projectId), type: 'VIDEO_RENDER', payload: { projectId, manifestId, manifestRevision, manifestDigest } as VideoJobPayload, idempotencyKey, maxAttempts: 3 });
  }

  private async withTransaction<T>(action: (executor: JobQueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const result = await action(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }

  async createManifestRenderJobForWorkspace(workspaceId: string, manifestId: string, idempotencySuffix?: string, renderOptions: Pick<VideoJobPayload, 'outputPath' | 'outputRoot'> = {}): Promise<JobRecord> {
    return this.withTransaction((executor) => this.createManifestRenderJobForWorkspaceWithExecutor(executor, workspaceId, manifestId, idempotencySuffix, renderOptions));
  }

  async createManifestRenderJobForWorkspaceWithExecutor(executor: JobQueryExecutor, workspaceId: string, manifestId: string, idempotencySuffix?: string, renderOptions: Pick<VideoJobPayload, 'outputPath' | 'outputRoot'> = {}): Promise<JobRecord> {
    const result = await executor.query<{ revision: number; workspace_id: string; manifest: EditManifestV0; manifest_digest: string | null; project_id: string | null }>('select m.revision, m.workspace_id, m.manifest, m.manifest_digest, w.project_id from edit_manifests m join video_workspaces w on w.id=m.workspace_id where m.id = $1 and m.workspace_id = $2', [manifestId, workspaceId]);
    const row = result.rows[0];
    if (!row) throw new Error('VIDEO_MANIFEST_NOT_FOUND');
    const manifestDigest = digestEditManifest(row.manifest);
    if (row.manifest_digest && row.manifest_digest !== manifestDigest) throw new Error('VIDEO_MANIFEST_DIGEST_CONFLICT');
    if (!row.manifest_digest) await executor.query('update edit_manifests set manifest_digest = $2 where id = $1 and manifest_digest is null', [manifestId, manifestDigest]);
    const idempotencyKey = `video-render:workspace:${workspaceId}:${manifestId}:v${Number(row.revision)}${idempotencySuffix ? `:${idempotencySuffix}` : ''}`;
    return this.jobs.createIdempotentWithExecutor(executor, { id: `job-${randomUUID()}`, projectId: row.project_id, workspaceId, type: 'VIDEO_RENDER', payload: { workspaceId, manifestId, manifestRevision: Number(row.revision), manifestDigest, ...renderOptions } as VideoJobPayload, idempotencyKey, maxAttempts: 3 });
  }

  async planJob(job: JobRecord): Promise<VideoPlanResult> {
    const payload = job.payload as VideoJobPayload;
    const projectId = job.projectId;
    if (payload.workspaceId) return this.planWorkspaceManifestJob(job, payload);
    if (!projectId || payload.projectId !== projectId) throw new Error('Job project scope does not match its Video payload');
    await this.ensureProjectWorkspace(projectId);
    const completed = await this.db.query<{ render_id: string; manifest_id: string; manifest: ReturnType<typeof buildVideoManifest>; render_status: string; output_asset_id: string }>("select r.id as render_id, m.id as manifest_id, m.manifest, r.status as render_status, r.output_asset_id from renders r join edit_manifests m on m.id = r.manifest_id and m.project_id = r.project_id where r.job_id = $1 and r.project_id = $2 and r.status = 'SUCCEEDED' and r.output_asset_id is not null order by r.created_at desc, r.id desc limit 1", [job.id, projectId]);
    const completedRender = completed.rows[0];
    if (completedRender) return { manifestId: completedRender.manifest_id, renderId: completedRender.render_id, manifest: completedRender.manifest, renderStatus: completedRender.render_status, outputAssetId: completedRender.output_asset_id };
    if (payload.manifestId) return this.planManifestJob(job, payload);
    const storage = this.storage;
    if (!storage) throw new Error('Video storage is required to plan a render');
    if (!this.assets) throw new Error('Asset catalog is required to plan a render');
    const result = await this.assets.listReadySourceAssets(projectId, payload.videoAssetIds, 'VIDEO');
    if (result.length !== payload.videoAssetIds.length) throw new Error('One or more video assets are unavailable');
    const byId = new Map(result.map((row) => [row.id, row]));
    const plannerAssets: PlannerAsset[] = payload.videoAssetIds.map((id) => {
      const row = byId.get(id); if (!row) throw new Error(`Asset ${id} not found`);
      return { id, storageKey: row.storageKey, sourcePath: storage.objectPath(row.storageKey), durationMs: Number(row.metadata.durationMs || 2000) };
    });
    let voicePath: string | undefined;
    if (payload.voiceAssetId) {
      const voice = await this.assets.getReadySourceAsset(projectId, payload.voiceAssetId, 'AUDIO');
      if (!voice) throw new Error('Voice asset is unavailable');
      voicePath = storage.objectPath(voice.storageKey);
    }
    let manifest = buildVideoManifest({ ...payload, projectId, assets: plannerAssets, ...(voicePath ? { voicePath } : {}) });
    if (payload.plannerType === 'STORYBOARD' && payload.storyboardScenes?.length && payload.metadata?.storyboardRevisionId) {
      const storyboardAssets = result.map((row) => ({ id: row.id, storageKey: row.storageKey, sourcePath: storage.objectPath(row.storageKey), durationMs: Number(row.metadata.durationMs || 2000), originalName: typeof row.metadata.originalName === 'string' ? row.metadata.originalName : row.id, tags: Array.isArray(row.metadata.tags) ? row.metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [], metadata: row.metadata }));
      manifest = buildStoryboardVideoManifest({ projectId, seed: payload.seed, storyboardRevisionId: payload.metadata.storyboardRevisionId, scenes: payload.storyboardScenes, assets: storyboardAssets, targetDurationMs: payload.targetDurationMs, ...(payload.voiceAssetId ? { voiceAssetId: payload.voiceAssetId } : {}), ...(voicePath ? { voicePath } : {}) }).manifest;
    }
    const client = await this.db.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`contentos:video-manifest:${projectId}`]);
      const existing = await client.query<{ render_id: string; manifest_id: string; manifest: ReturnType<typeof buildVideoManifest>; render_status: string; output_asset_id: string | null }>('select r.id as render_id, m.id as manifest_id, m.manifest, r.status as render_status, r.output_asset_id from renders r join edit_manifests m on m.id = r.manifest_id and m.project_id = r.project_id where r.job_id = $1 and r.project_id = $2 order by r.created_at desc, r.id desc limit 1', [job.id, projectId]);
      const prior = existing.rows[0];
      if (prior) {
        await client.query('commit');
        return { manifestId: prior.manifest_id, renderId: prior.render_id, manifest: prior.manifest, renderStatus: prior.render_status, outputAssetId: prior.output_asset_id };
      }
      await client.query("update edit_manifests set status = 'SUPERSEDED' where project_id = $1 and status = 'PERSISTED'", [projectId]);
      const revisionResult = await client.query<{ revision: number }>('select coalesce(max(revision), 0) + 1 as revision from edit_manifests where project_id = $1', [projectId]);
      const revision = Number(revisionResult.rows[0]?.revision || 1);
      const manifestId = `manifest-${randomUUID()}`;
      await client.query('insert into edit_manifests (id, project_id, workspace_id, revision, schema_version, manifest, manifest_digest, status) values ($1, $2, $3, $4, $5, $6, $7, $8)', [manifestId, projectId, projectWorkspaceId(projectId), revision, 'EDIT_MANIFEST_V0', manifest, digestEditManifest(manifest), 'PERSISTED']);
      const renderId = `render-${randomUUID()}`;
      await client.query('insert into renders (id, project_id, workspace_id, manifest_id, job_id, status, diagnostics) values ($1, $2, $3, $4, $5, $6, $7)', [renderId, projectId, projectWorkspaceId(projectId), manifestId, job.id, 'QUEUED', { seed: payload.seed, ...(payload.metadata ? { metadata: payload.metadata } : {}) }]);
      await client.query('commit');
      return { manifestId, renderId, manifest, renderStatus: 'QUEUED', outputAssetId: null };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  private async planManifestJob(job: JobRecord, payload: VideoJobPayload): Promise<VideoPlanResult> {
    if (!payload.manifestId || !Number.isInteger(payload.manifestRevision)) throw new Error('VIDEO_MANIFEST_REVISION_REQUIRED');
    if (!payload.manifestDigest) throw new Error('VIDEO_MANIFEST_DIGEST_REQUIRED');
    if (!this.storage || !this.assets) throw new Error('Video storage and asset catalog are required for exact Manifest rendering');
    const selected = await this.db.query<{ id: string; project_id: string; revision: number; manifest: EditManifestV0; manifest_digest: string | null }>('select id, project_id, revision, manifest, manifest_digest from edit_manifests where id = $1 and project_id = $2', [payload.manifestId, job.projectId]);
    const row = selected.rows[0];
    if (!row) throw new Error('VIDEO_MANIFEST_NOT_FOUND');
    if (Number(row.revision) !== payload.manifestRevision) throw new Error('VIDEO_MANIFEST_REVISION_CONFLICT');
    const currentDigest = digestEditManifest(row.manifest);
    if (payload.manifestDigest !== currentDigest || (row.manifest_digest && row.manifest_digest !== currentDigest)) throw new Error('VIDEO_MANIFEST_DIGEST_CONFLICT');
    const persisted = row.manifest;
    validateEditManifest(persisted);
    const ids = [...new Set(persisted.timeline.map((clip) => clip.assetId))];
    const localIds = ids.filter((id) => id.startsWith('local-'));
    const projectIds = ids.filter((id) => !id.startsWith('local-'));
    const manifest = structuredClone(persisted);
    const projectSources = projectIds.length > 0 ? await this.assets.listReadySourceAssets(job.projectId!, projectIds, 'VIDEO') : [];
    const projectIdsResolved = new Set(projectSources.map((source) => source.id));
    const unresolvedProjectIds = projectIds.filter((id) => !projectIdsResolved.has(id));
    const globalSources = unresolvedProjectIds.length > 0 ? await this.assets.listReadyGlobalVideoAssets(unresolvedProjectIds) : [];
    const projectById = new Map([...projectSources, ...globalSources].map((source) => [source.id, source]));
    if (projectById.size !== projectIds.length) throw new Error('VIDEO_MANIFEST_SOURCE_UNAVAILABLE');
    const localById = new Map<string, { sourcePath: string; durationMs: number }>();
    for (const localId of localIds) {
      const rootId = localId.split(':', 1)[0] || '';
      const result = await this.db.query<{ source_path: string; duration_ms: number; available: boolean }>("select f.source_path, f.duration_ms, f.available from local_media_scan_files f join local_media_scans s on s.id = f.scan_id where s.project_id = $1 and s.source_root_id = $2 and f.file_id = $3 and s.status = 'SUCCEEDED' order by s.scanned_at desc nulls last limit 1", [job.projectId, rootId, localId]);
      const row = result.rows[0];
       if (!row?.available || !row.source_path || !(await authorizedLocalSource(row.source_path, this.pathAccess))) throw new Error(`VIDEO_MANIFEST_SOURCE_UNAVAILABLE: ${localId}`);
      try { await access(row.source_path); } catch { throw new Error(`VIDEO_MANIFEST_SOURCE_UNAVAILABLE: ${localId}`); }
      localById.set(localId, { sourcePath: row.source_path, durationMs: Number(row.duration_ms) });
    }
    manifest.timeline = await Promise.all(manifest.timeline.map(async (clip) => {
      const local = localById.get(clip.assetId);
      const source = local ? null : projectById.get(clip.assetId);
      const duration = local?.durationMs ?? (source ? Number(source.metadata.durationMs) : Number.NaN);
      if (!local && !source) throw new Error(`VIDEO_MANIFEST_SOURCE_UNAVAILABLE: ${clip.assetId}`);
      if (!Number.isFinite(duration) || clip.sourceInMs + clip.durationMs > duration) throw new Error(`VIDEO_MANIFEST_CLIP_OUT_OF_BOUNDS: ${clip.assetId}`);
      return { ...clip, sourcePath: local ? local.sourcePath : this.storage!.objectPath(source!.storageKey) };
    }));
    if (manifest.audio.voiceAssetId) {
      const voice = await this.assets.getReadySourceAsset(job.projectId!, manifest.audio.voiceAssetId, 'AUDIO');
      if (!voice) throw new Error('VIDEO_MANIFEST_VOICE_UNAVAILABLE');
      manifest.audio = { ...manifest.audio, voicePath: this.storage.objectPath(voice.storageKey) };
    }
    const client = await this.db.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`contentos:video-manifest:${job.projectId}`]);
      const existing = await client.query<{ render_id: string; manifest_id: string; manifest: EditManifestV0; render_status: string; output_asset_id: string | null }>('select r.id as render_id, m.id as manifest_id, m.manifest, r.status as render_status, r.output_asset_id from renders r join edit_manifests m on m.id = r.manifest_id and m.project_id = r.project_id where r.job_id = $1 and r.project_id = $2 order by r.created_at desc, r.id desc limit 1', [job.id, job.projectId]);
      const prior = existing.rows[0];
      if (prior) { await client.query('commit'); return { manifestId: prior.manifest_id, renderId: prior.render_id, manifest: prior.manifest, renderStatus: prior.render_status, outputAssetId: prior.output_asset_id }; }
      const renderId = `render-${randomUUID()}`;
      await client.query('insert into renders (id, project_id, workspace_id, manifest_id, job_id, status, diagnostics) values ($1, $2, $3, $4, $5, $6, $7)', [renderId, job.projectId, projectWorkspaceId(job.projectId!), payload.manifestId, job.id, 'QUEUED', { manifestRevision: payload.manifestRevision }]);
      await client.query('commit');
      return { manifestId: payload.manifestId, renderId, manifest, renderStatus: 'QUEUED', outputAssetId: null };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  private async planWorkspaceManifestJob(job: JobRecord, payload: VideoJobPayload): Promise<VideoPlanResult> {
    if (!payload.manifestId || !Number.isInteger(payload.manifestRevision) || !payload.manifestDigest || !payload.workspaceId) throw new Error('VIDEO_MANIFEST_SCOPE_REQUIRED');
    if (!this.storage || !this.assets) throw new Error('Video storage and asset catalog are required for exact Manifest rendering');
    const selected = await this.db.query<{ id: string; workspace_id: string; revision: number; manifest: EditManifestV0; manifest_digest: string | null; project_id: string | null }>('select m.id, m.workspace_id, m.revision, m.manifest, m.manifest_digest, w.project_id from edit_manifests m join video_workspaces w on w.id=m.workspace_id where m.id = $1 and m.workspace_id = $2', [payload.manifestId, payload.workspaceId]);
    const row = selected.rows[0];
    if (!row) throw new Error('VIDEO_MANIFEST_NOT_FOUND');
    if (Number(row.revision) !== payload.manifestRevision) throw new Error('VIDEO_MANIFEST_REVISION_CONFLICT');
    const currentDigest = digestEditManifest(row.manifest);
    if (payload.manifestDigest !== currentDigest || (row.manifest_digest && row.manifest_digest !== currentDigest)) throw new Error('VIDEO_MANIFEST_DIGEST_CONFLICT');
    validateEditManifest(row.manifest);
    const sources = await this.assets.listReadyWorkspaceAssets(payload.workspaceId, 'VIDEO');
    const byId = new Map(sources.map((source) => [source.id, source]));
    const manifest = structuredClone(row.manifest);
    manifest.timeline = await Promise.all(manifest.timeline.map(async (clip) => {
      if (clip.assetId.startsWith('local-')) {
        const candidate = clip.sourcePath;
         if (!(await authorizedLocalSource(candidate, this.pathAccess))) throw new Error(`VIDEO_MANIFEST_SOURCE_UNAVAILABLE: ${clip.assetId}`);
        return { ...clip, sourcePath: candidate };
      }
      const source = byId.get(clip.assetId);
      if (!source) throw new Error(`VIDEO_MANIFEST_SOURCE_UNAVAILABLE: ${clip.assetId}`);
      const duration = Number(source.metadata.durationMs);
      if (!Number.isFinite(duration) || clip.sourceInMs + clip.durationMs > duration) throw new Error(`VIDEO_MANIFEST_CLIP_OUT_OF_BOUNDS: ${clip.assetId}`);
      return { ...clip, sourcePath: this.storage!.objectPath(source.storageKey) };
    }));
    if (manifest.audio.voiceAssetId) {
      const voice = await this.assets.getReadyWorkspaceAsset(payload.workspaceId, manifest.audio.voiceAssetId, 'AUDIO', 'VOICE');
      if (!voice) throw new Error('VIDEO_MANIFEST_VOICE_UNAVAILABLE');
      manifest.audio = { ...manifest.audio, voicePath: this.storage.objectPath(voice.storageKey) };
    }
    const existing = await this.db.query<{ render_id: string; manifest_id: string; manifest: EditManifestV0; render_status: string; output_asset_id: string | null }>('select r.id as render_id, r.manifest_id, m.manifest, r.status as render_status, r.output_asset_id from renders r join edit_manifests m on m.id = r.manifest_id and m.workspace_id = r.workspace_id where r.job_id = $1 and r.workspace_id = $2 order by r.created_at desc, r.id desc limit 1', [job.id, payload.workspaceId]);
    const prior = existing.rows[0];
    if (prior) return { manifestId: prior.manifest_id, renderId: prior.render_id, manifest, renderStatus: prior.render_status, outputAssetId: prior.output_asset_id };
    const renderId = `render-${randomUUID()}`;
    await this.db.query('insert into renders (id, project_id, workspace_id, manifest_id, job_id, status, diagnostics) values ($1, $2, $3, $4, $5, $6, $7)', [renderId, row.project_id, payload.workspaceId, payload.manifestId, job.id, 'QUEUED', { manifestRevision: payload.manifestRevision }]);
    return { manifestId: payload.manifestId, renderId, manifest, renderStatus: 'QUEUED', outputAssetId: null };
  }

  async startRender(renderId: string, attempt: JobAttemptScope, diagnostics: unknown = {}): Promise<boolean> {
    const result = await attempt.query("update renders set status = 'RUNNING', attempt_id = $2, attempt_number = $3, diagnostics = $4, finished_at = null where id = $1 and job_id = $5 and status not in ('SUCCEEDED', 'CANCELLED') and (attempt_number is null or attempt_number < $3 or (attempt_number = $3 and attempt_id = $2)) returning id", [renderId, attempt.attemptId, attempt.attemptNumber, diagnostics, attempt.jobId]);
    return Boolean(result.rowCount);
  }

  async completeRender(renderId: string, attempt: JobAttemptScope, outputAssetId: string, diagnostics: unknown): Promise<boolean> {
    const result = await attempt.query("update renders set status = 'SUCCEEDED', output_asset_id = $3, diagnostics = $4, finished_at = now() where id = $1 and job_id = $5 and attempt_id = $2 and attempt_number = $6 and status = 'RUNNING' returning id", [renderId, attempt.attemptId, outputAssetId, diagnostics, attempt.jobId, attempt.attemptNumber]);
    return Boolean(result.rowCount);
  }

  async failRender(renderId: string, attempt: JobAttemptScope, diagnostics: unknown): Promise<boolean> {
    const result = await attempt.query("update renders set status = 'FAILED', diagnostics = $3, finished_at = now() where id = $1 and job_id = $4 and attempt_id = $2 and attempt_number = $5 and status = 'RUNNING' returning id", [renderId, attempt.attemptId, diagnostics, attempt.jobId, attempt.attemptNumber]);
    return Boolean(result.rowCount);
  }

  async cancelRender(renderId: string, attempt: JobAttemptScope, diagnostics: unknown): Promise<boolean> {
    const result = await attempt.query("update renders set status = 'CANCELLED', diagnostics = $3, finished_at = now() where id = $1 and job_id = $4 and attempt_id = $2 and attempt_number = $5 and status = 'RUNNING' returning id", [renderId, attempt.attemptId, diagnostics, attempt.jobId, attempt.attemptNumber]);
    return Boolean(result.rowCount);
  }

  async cancelCurrentRender(attempt: JobAttemptScope, diagnostics: unknown): Promise<number> {
    const result = await attempt.query("update renders set status = 'CANCELLED', diagnostics = $2, finished_at = now() where job_id = $1 and attempt_id = $3 and attempt_number = $4 and status = 'RUNNING' returning id", [attempt.jobId, diagnostics, attempt.attemptId, attempt.attemptNumber]);
    return result.rowCount || 0;
  }

  async recoverLeaseWithExecutor(scope: JobAttemptScope, job: JobRecord, context: JobLeaseRecoveryContext): Promise<boolean> {
    if (scope.jobId !== job.id) return false;
    const payload = job.payload && typeof job.payload === 'object' ? job.payload as Record<string, unknown> : {};
    const workspaceId = job.workspaceId || (job.projectId ? projectWorkspaceId(job.projectId) : null);
    const terminal = context.outcome === 'FAILED';
    if (job.type === 'VIDEO_RENDER') {
      if (!workspaceId || (job.projectId && job.workspaceId && job.workspaceId !== projectWorkspaceId(job.projectId)) || (payload.workspaceId && payload.workspaceId !== workspaceId) || (payload.projectId && payload.projectId !== job.projectId)) return false;
      const associated = await scope.query<{ status: string; project_id: string | null; workspace_id: string | null; attempt_id: string | null; attempt_number: number | null }>('select status,project_id,workspace_id,attempt_id,attempt_number from renders where job_id=$1 for update', [job.id]);
      if (associated.rows.some((row) => row.status === 'SUCCEEDED' || row.project_id !== job.projectId || row.workspace_id !== workspaceId || Number(row.attempt_number) > scope.attemptNumber || (Number(row.attempt_number) === scope.attemptNumber && row.attempt_id !== scope.attemptId) || (['RUNNING', 'VALIDATING'].includes(row.status) && (row.attempt_id !== scope.attemptId || Number(row.attempt_number) !== scope.attemptNumber)))) return false;
      if (!associated.rows.length) {
        if (payload.manifestId) {
          const manifest = await scope.query('select id from edit_manifests where id=$1 and workspace_id=$2 and project_id is not distinct from $3', [payload.manifestId, workspaceId, job.projectId]);
          if (!manifest.rowCount) return false;
        } else if (!job.projectId || !Array.isArray(payload.videoAssetIds) || !payload.videoAssetIds.length) return false;
      }
      const changed = await scope.query<{ manifest_id: string; render_id: string; manifest: EditManifestV0 }>(`with changed as (
        update renders set status=$5,diagnostics=$6,finished_at=case when $5='FAILED' then now() else null end
          where job_id=$1 and ((attempt_id=$2 and attempt_number=$3 and status in ('RUNNING','VALIDATING','QUEUED','PLANNED'))
            or (status in ('QUEUED','PLANNED') and (attempt_number is null or attempt_number<$3)))
            and (($7::text is not null and project_id=$7) or ($7::text is null and workspace_id=$4))
          returning id,manifest_id
      ) select c.id as render_id,c.manifest_id,m.manifest from changed c join edit_manifests m on m.id=c.manifest_id`, [job.id, scope.attemptId, scope.attemptNumber, workspaceId, terminal ? 'FAILED' : 'QUEUED', context.error, job.projectId]);
      if (terminal) {
        for (const row of changed.rows) {
          const planId = row.manifest.metadata?.editorialPlanId;
          const sessionId = row.manifest.metadata?.v3SessionId;
          if (planId) await scope.query(`update edit_script_plans set status='FAILED',updated_at=now()
            where id::text=$1 and workspace_id=$3 and current_manifest_id=$2 and status='RENDERING'
              and not exists (select 1 from renders where manifest_id=$2 and id<>$4 and status in ('RUNNING','SUCCEEDED'))`, [planId, row.manifest_id, workspaceId, row.render_id]);
          if (sessionId) await scope.query(`update script_editing_v3_sessions set status='FAILED',updated_at=now()
            where id=$1 and workspace_id=$3 and current_manifest_id=$2 and status='RENDERING'
              and not exists (select 1 from renders where manifest_id=$2 and id<>$4 and status in ('RUNNING','SUCCEEDED'))`, [sessionId, row.manifest_id, workspaceId, row.render_id]);
        }
        const items = await scope.query<{ batch_id: string }>(`update edit_batch_items set state='FAILED',error=$3,updated_at=now()
          where job_id=$1 and workspace_id=$2 and state in ('QUEUED','RUNNING','RENDERING') returning batch_id`, [job.id, workspaceId, context.error]);
        for (const batchId of new Set(items.rows.map((item) => item.batch_id))) await this.refreshRecoveredBatch(scope, batchId);
      }
      return true;
    }
    if (job.type === 'EDIT_PREPARE_ITEM') {
      const items = await scope.query<{ batch_id: string }>(`update edit_batch_items set state=$5,error=$6,updated_at=now()
        where id=$1 and batch_id=$2 and workspace_id=$3 and prepare_job_id=$4 and job_id is null
          and state in ('QUEUED','PREPARING','RUNNING') returning batch_id`, [payload.itemId || '', payload.batchId || '', workspaceId, job.id, terminal ? 'FAILED' : 'PREPARING', context.error]);
      for (const batchId of new Set(items.rows.map((item) => item.batch_id))) await this.refreshRecoveredBatch(scope, batchId);
      return true;
    }
    if (job.type === 'EDIT_EXPORT') {
      await scope.query(`update edit_exports e set status=$5,error=$6,finished_at=case when $5='FAILED' then now() else null end
        where e.id=$1 and e.batch_item_id=$2 and e.job_id=$3 and e.status in ('QUEUED','RUNNING')
          and exists (select 1 from edit_batch_items i where i.id=e.batch_item_id and i.workspace_id=$4)`, [payload.exportId || '', payload.batchItemId || '', job.id, workspaceId, terminal ? 'FAILED' : 'QUEUED', context.error]);
      return true;
    }
    if (job.type === 'EDIT_SCRIPT_PLAN') {
      await scope.query(`update edit_script_plans set status=$4,updated_at=now()
        where id::text=$1 and workspace_id=$2 and job_id=$3 and status in ('QUEUED','PLANNING')`, [payload.planId || '', workspaceId, job.id, terminal ? 'FAILED' : 'QUEUED']);
      return true;
    }
    if (job.type === 'SHOT_DETECTION_V1') {
      const run = (await scope.query<{ status: string; lease_authority: { jobId?: string; attemptId?: string; attemptNumber?: number } | null }>(`select r.status,r.lease_authority from script_editing_v3_shot_detection_runs r
        join material_pool_snapshots s on s.id=r.snapshot_id
        where r.id=$1 and r.snapshot_id=$2 and r.asset_id=$3 and r.source_fingerprint=$4 and s.workspace_id=$5 for update of r`, [payload.runId || '', payload.snapshotId || '', payload.assetId || '', payload.sourceFingerprint || '', workspaceId])).rows[0];
      if (!run || !['QUEUED', 'RUNNING'].includes(run.status) || run.lease_authority?.jobId !== job.id || run.lease_authority.attemptId !== scope.attemptId || run.lease_authority.attemptNumber !== scope.attemptNumber) return false;
      await scope.query(`update script_editing_v3_shot_detection_runs r set status=$6,error=$7,updated_at=now()
        where r.id=$1 and r.snapshot_id=$2 and r.asset_id=$3 and r.source_fingerprint=$4 and r.status in ('QUEUED','RUNNING')
          and exists (select 1 from material_pool_snapshots s where s.id=r.snapshot_id and s.workspace_id=$5)
          and r.lease_authority->>'jobId'=$8 and r.lease_authority->>'attemptId'=$9 and r.lease_authority->>'attemptNumber'=$10`, [payload.runId || '', payload.snapshotId || '', payload.assetId || '', payload.sourceFingerprint || '', workspaceId, terminal ? 'FAILED' : 'QUEUED', context.error, job.id, scope.attemptId, String(scope.attemptNumber)]);
      return true;
    }
    if (job.type === 'ANALYZE_ASSET_VISUAL') {
      const source = (await scope.query<{ file_size: number | null; modified_at: string | null; duration_ms: number }>(`select i.file_size,i.modified_at,i.duration_ms
        from material_pool_items i join material_pool_snapshots s on s.id=i.snapshot_id
          where i.snapshot_id=$1 and i.asset_id=$2 and s.workspace_id=$3`, [payload.snapshotId || '', payload.assetId || '', workspaceId])).rows[0];
      if (!source) return false;
      const profile = (await scope.query<{ status: string; source_fingerprint: string; analysis_config: string; lease_authority: { jobId?: string; attemptId?: string; attemptNumber?: number } | null }>(`select status,source_fingerprint,
        concat(model_name,':',model_version,':',prompt_version,':',analysis_version) as analysis_config,
        profile->'leaseAuthority' as lease_authority from asset_visual_profiles where asset_id=$1 for update`, [payload.assetId || ''])).rows[0];
      if (profile && profile.status !== 'PENDING') return false;
      if (profile?.status === 'PENDING') {
        const fingerprint = materialSourceFingerprint({ fileSize: source.file_size, modifiedAt: source.modified_at, durationMs: Number(source.duration_ms) });
        if (profile.source_fingerprint !== fingerprint || profile.analysis_config !== payload.analysisConfig || profile.lease_authority?.jobId !== job.id || profile.lease_authority.attemptId !== scope.attemptId || profile.lease_authority.attemptNumber !== scope.attemptNumber) return false;
        if (terminal) await scope.query(`update asset_visual_profiles set status='FAILED',error=$3,updated_at=now()
          where asset_id=$1 and source_fingerprint=$2 and status='PENDING'
            and profile->'leaseAuthority'->>'jobId'=$4 and profile->'leaseAuthority'->>'attemptId'=$5
            and profile->'leaseAuthority'->>'attemptNumber'=$6`, [payload.assetId || '', fingerprint, context.error, job.id, scope.attemptId, String(scope.attemptNumber)]);
      }
      return true;
    }
    // These jobs only persist ready outputs; they have no durable in-progress owner row.
    return ['GENERATE_REPRESENTATIVE_FRAMES', 'EDIT_V3_DRAFT_PREVIEW', 'IMPORT_JIANYING_DRAFT'].includes(job.type);
  }

  private async refreshRecoveredBatch(scope: JobQueryExecutor, batchId: string): Promise<void> {
    await scope.query(`with summary as (
      select b.total_count,count(i.id)::int as actual,
        count(i.id) filter (where i.state='SUCCEEDED')::int as succeeded,
        count(i.id) filter (where i.state='FAILED')::int as failed,
        count(i.id) filter (where i.state in ('QUEUED','PREPARING','RENDERING','RUNNING'))::int as active
        from edit_batches b left join edit_batch_items i on i.batch_id=b.id where b.id=$1 group by b.total_count
    ) update edit_batches b set status=case
        when s.actual<>s.total_count then 'FAILED' when s.active>0 then 'RUNNING'
        when s.failed>0 and s.succeeded>0 then 'PARTIAL' when s.failed>0 then 'FAILED'
        when s.succeeded=s.total_count and s.total_count>0 then 'SUCCEEDED' else b.status end,
      succeeded_count=s.succeeded,failed_count=s.failed+greatest(s.total_count-s.actual,0),updated_at=now()
      from summary s where b.id=$1`, [batchId]);
  }
}
