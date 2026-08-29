import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { LocalStorageProvider } from '../../../infrastructure/storage/src/index.js';
import type { AssetCatalogService } from '../../asset/src/index.js';
import { JobService, type JobAttemptScope, type JobRecord } from '../../job/src/index.js';
import { buildVideoManifest, type PlannerAsset } from './planner.js';
import { validateEditManifest, type EditManifestV0 } from '../../../contracts/src/index.js';
import { digestEditManifest } from './quick-edit.js';

export interface CreateVideoJobInput { projectId: string; videoAssetIds: string[]; voiceAssetId?: string; targetDurationMs: number; seed: number; subtitleText?: string; idempotencyKey?: string; directorRevisionId?: string; directorRevision?: number; directorBrief?: unknown; directorStoryboard?: unknown; metadata?: { briefId?: string; scriptRevisionId?: string; storyboardRevisionId?: string }; }
export interface VideoJobPayload extends CreateVideoJobInput { manifestId?: string; manifestRevision?: number; manifestDigest?: string; }
export interface VideoPlanResult { manifestId: string; renderId: string; manifest: ReturnType<typeof buildVideoManifest>; renderStatus: string; outputAssetId: string | null; }

export class VideoService {
  private readonly db: Pool;
  private readonly storage: LocalStorageProvider | null;
  private readonly jobs: JobService;
  private readonly assets: AssetCatalogService | null;
  constructor(db: Pool, storage: LocalStorageProvider, jobs: JobService, assets?: AssetCatalogService);
  constructor(db: Pool, jobs: JobService, assets?: AssetCatalogService);
  constructor(db: Pool, storageOrJobs: LocalStorageProvider | JobService, maybeJobs?: JobService | AssetCatalogService, maybeAssets?: AssetCatalogService) {
    this.db = db;
    this.storage = maybeJobs && 'create' in maybeJobs ? storageOrJobs as LocalStorageProvider : null;
    this.jobs = (maybeJobs && 'create' in maybeJobs ? maybeJobs : storageOrJobs) as JobService;
    this.assets = (maybeJobs && !('create' in maybeJobs) ? maybeJobs : maybeAssets) || null;
  }

  async createJob(input: CreateVideoJobInput): Promise<JobRecord> {
    if (input.videoAssetIds.length === 0) throw new Error('At least one video asset is required');
    const idempotencyKey = input.idempotencyKey || `video-render:${input.projectId}:${input.seed}:${input.targetDurationMs}:${input.videoAssetIds.join(',')}`;
    const id = `job-${randomUUID()}`;
    try { return await this.jobs.create({ id, projectId: input.projectId, type: 'VIDEO_RENDER', payload: input, idempotencyKey, maxAttempts: 3 }); }
    catch (error) { if ((error as { code?: string }).code === '23505') { const existing = await this.jobs.getByIdempotencyKey(idempotencyKey); if (existing) return existing; } throw error; }
  }

  async createManifestRenderJob(projectId: string, manifestId: string): Promise<JobRecord> {
    const manifest = await this.db.query<{ revision: number; project_id: string; manifest: EditManifestV0; manifest_digest: string | null }>('select revision, project_id, manifest, manifest_digest from edit_manifests where id = $1 and project_id = $2', [manifestId, projectId]);
    const row = manifest.rows[0];
    if (!row) throw new Error('VIDEO_MANIFEST_NOT_FOUND');
    const manifestRevision = Number(row.revision);
    const manifestDigest = digestEditManifest(row.manifest);
    if (row.manifest_digest && row.manifest_digest !== manifestDigest) throw new Error('VIDEO_MANIFEST_DIGEST_CONFLICT');
    if (!row.manifest_digest) await this.db.query('update edit_manifests set manifest_digest = $2 where id = $1 and manifest_digest is null', [manifestId, manifestDigest]);
    const idempotencyKey = `video-render:manifest:${projectId}:${manifestId}:v${manifestRevision}`;
    const id = `job-${randomUUID()}`;
    const payload = { projectId, manifestId, manifestRevision, manifestDigest } as unknown as VideoJobPayload;
    try { return await this.jobs.create({ id, projectId, type: 'VIDEO_RENDER', payload, idempotencyKey, maxAttempts: 3 }); }
    catch (error) { if ((error as { code?: string }).code === '23505') { const existing = await this.jobs.getByIdempotencyKey(idempotencyKey); if (existing) return existing; } throw error; }
  }

  async planJob(job: JobRecord): Promise<VideoPlanResult> {
    const payload = job.payload as VideoJobPayload;
    const projectId = job.projectId;
    if (!projectId || payload.projectId !== projectId) throw new Error('Job project scope does not match its Video payload');
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
    const manifest = buildVideoManifest({ ...payload, projectId, assets: plannerAssets, ...(voicePath ? { voicePath } : {}) });
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
      await client.query('insert into edit_manifests (id, project_id, revision, schema_version, manifest, manifest_digest, status) values ($1, $2, $3, $4, $5, $6, $7)', [manifestId, projectId, revision, 'EDIT_MANIFEST_V0', manifest, digestEditManifest(manifest), 'PERSISTED']);
      const renderId = `render-${randomUUID()}`;
      await client.query('insert into renders (id, project_id, manifest_id, job_id, status, diagnostics) values ($1, $2, $3, $4, $5, $6)', [renderId, projectId, manifestId, job.id, 'QUEUED', { seed: payload.seed, ...(payload.metadata ? { metadata: payload.metadata } : {}) }]);
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
    const sources = await this.assets.listReadySourceAssets(job.projectId!, ids, 'VIDEO');
    if (sources.length !== ids.length) throw new Error('VIDEO_MANIFEST_SOURCE_UNAVAILABLE');
    const byId = new Map(sources.map((source) => [source.id, source]));
    const manifest = structuredClone(persisted);
    manifest.timeline = manifest.timeline.map((clip) => {
      const source = byId.get(clip.assetId);
      if (!source) throw new Error(`VIDEO_MANIFEST_SOURCE_UNAVAILABLE: ${clip.assetId}`);
      const duration = Number(source.metadata.durationMs);
      if (!Number.isFinite(duration) || clip.sourceInMs + clip.durationMs > duration) throw new Error(`VIDEO_MANIFEST_CLIP_OUT_OF_BOUNDS: ${clip.assetId}`);
      return { ...clip, sourcePath: this.storage!.objectPath(source.storageKey) };
    });
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
      await client.query('insert into renders (id, project_id, manifest_id, job_id, status, diagnostics) values ($1, $2, $3, $4, $5, $6)', [renderId, job.projectId, payload.manifestId, job.id, 'QUEUED', { manifestRevision: payload.manifestRevision }]);
      await client.query('commit');
      return { manifestId: payload.manifestId, renderId, manifest, renderStatus: 'QUEUED', outputAssetId: null };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
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
}
