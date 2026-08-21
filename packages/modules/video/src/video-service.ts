import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { LocalStorageProvider } from '../../../infrastructure/storage/src/index.js';
import { JobService, type JobRecord } from '../../job/src/index.js';
import { buildVideoManifest, type PlannerAsset } from './planner.js';

export interface CreateVideoJobInput { projectId: string; videoAssetIds: string[]; voiceAssetId?: string; targetDurationMs: number; seed: number; subtitleText?: string; }
export interface VideoJobPayload extends CreateVideoJobInput {}

export class VideoService {
  constructor(private readonly db: Pool, private readonly storage: LocalStorageProvider, private readonly jobs: JobService) {}

  async createJob(input: CreateVideoJobInput): Promise<JobRecord> {
    if (input.videoAssetIds.length === 0) throw new Error('At least one video asset is required');
    const id = `job-${randomUUID()}`;
    return this.jobs.create({ id, projectId: input.projectId, type: 'VIDEO_RENDER', payload: input, idempotencyKey: `video-render:${input.projectId}:${input.seed}:${input.targetDurationMs}:${input.videoAssetIds.join(',')}`, maxAttempts: 3 });
  }

  async planJob(job: JobRecord): Promise<{ manifestId: string; renderId: string; manifest: ReturnType<typeof buildVideoManifest> }> {
    const payload = job.payload as VideoJobPayload;
    const result = await this.db.query<Record<string, unknown>>('select id, storage_key, metadata from assets where id = any($1::text[]) and lifecycle = $2 and kind = $3', [payload.videoAssetIds, 'READY', 'VIDEO']);
    if (result.rows.length !== payload.videoAssetIds.length) throw new Error('One or more video assets are unavailable');
    const byId = new Map(result.rows.map((row) => [String(row.id), row]));
    const plannerAssets: PlannerAsset[] = payload.videoAssetIds.map((id) => {
      const row = byId.get(id); if (!row) throw new Error(`Asset ${id} not found`);
      const metadata = (row.metadata || {}) as Record<string, unknown>;
      return { id, storageKey: String(row.storage_key), sourcePath: this.storage.objectPath(String(row.storage_key)), durationMs: Number(metadata.durationMs || 2000) };
    });
    let voicePath: string | undefined;
    if (payload.voiceAssetId) {
      const voice = await this.db.query<{ storage_key: string }>('select storage_key from assets where id = $1 and lifecycle = $2 and kind = $3', [payload.voiceAssetId, 'READY', 'AUDIO']);
      if (!voice.rows[0]) throw new Error('Voice asset is unavailable');
      voicePath = this.storage.objectPath(voice.rows[0].storage_key);
    }
    const manifest = buildVideoManifest({ ...payload, assets: plannerAssets, ...(voicePath ? { voicePath } : {}) });
    await this.db.query("update edit_manifests set status = 'SUPERSEDED' where project_id = $1 and status = 'PERSISTED'", [payload.projectId]);
    const revisionResult = await this.db.query<{ revision: number }>('select coalesce(max(revision), 0) + 1 as revision from edit_manifests where project_id = $1', [payload.projectId]);
    const revision = Number(revisionResult.rows[0]?.revision || 1);
    const manifestId = `manifest-${randomUUID()}`;
    await this.db.query('insert into edit_manifests (id, project_id, revision, schema_version, manifest, status) values ($1, $2, $3, $4, $5, $6)', [manifestId, payload.projectId, revision, 'EDIT_MANIFEST_V0', manifest, 'PERSISTED']);
    const renderId = `render-${randomUUID()}`;
    await this.db.query('insert into renders (id, project_id, manifest_id, job_id, status, diagnostics) values ($1, $2, $3, $4, $5, $6)', [renderId, payload.projectId, manifestId, job.id, 'QUEUED', { seed: payload.seed }]);
    return { manifestId, renderId, manifest };
  }

  async updateRender(renderId: string, status: string, diagnostics: unknown = {}): Promise<void> {
    await this.db.query('update renders set status = $2, diagnostics = $3, finished_at = case when $2 in (\'SUCCEEDED\', \'FAILED\', \'CANCELLED\') then now() else finished_at end where id = $1', [renderId, status, diagnostics]);
  }

  async completeRender(renderId: string, outputAssetId: string, diagnostics: unknown): Promise<void> {
    await this.db.query('update renders set status = \'SUCCEEDED\', output_asset_id = $2, diagnostics = $3, finished_at = now() where id = $1', [renderId, outputAssetId, diagnostics]);
  }
}
