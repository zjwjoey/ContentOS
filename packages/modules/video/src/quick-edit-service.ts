import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AssetCatalogService } from '../../asset/src/index.js';
import type { LocalMediaSourceService } from '../../asset/src/index.js';
import { applyQuickEditOperations, digestEditManifest, parseQuickEditOperations, type QuickEditOperation } from './quick-edit.js';
import { validateEditManifest, type EditManifestV0 } from '../../../contracts/src/index.js';

export interface CreateQuickEditVersionInput {
  projectId?: string;
  workspaceId?: string;
  parentManifestId: string;
  operations: QuickEditOperation[];
  createdBy: string;
  idempotencyKey?: string;
}

export interface QuickEditManifestRecord {
  id: string;
  projectId: string;
  workspaceId: string;
  revision: number;
  status: 'PERSISTED' | 'SUPERSEDED';
  parentManifestId: string | null;
  editOperations: QuickEditOperation[];
  createdBy: string | null;
  manifest: EditManifestV0;
  createdAt: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(input: Pick<CreateQuickEditVersionInput, 'projectId' | 'parentManifestId' | 'operations' | 'createdBy'>): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

function mapRecord(row: Record<string, unknown>): QuickEditManifestRecord {
  return {
    id: String(row.id), projectId: row.project_id ? String(row.project_id) : '', workspaceId: row.workspace_id ? String(row.workspace_id) : '', revision: Number(row.revision), status: row.status as QuickEditManifestRecord['status'],
    parentManifestId: row.parent_manifest_id ? String(row.parent_manifest_id) : null,
    editOperations: Array.isArray(row.edit_operations) ? row.edit_operations as QuickEditOperation[] : [],
    createdBy: row.created_by ? String(row.created_by) : null,
    manifest: row.manifest as EditManifestV0,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function sourceDuration(asset: { metadata: Record<string, unknown> }, assetId: string): number {
  const duration = Number(asset.metadata.durationMs);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Source asset ${assetId} has no valid duration`);
  return duration;
}

export class VideoAdjustmentService {
  constructor(private readonly db: Pool, private readonly assets: AssetCatalogService, private readonly localMedia?: LocalMediaSourceService) {}

  async listManifests(projectId: string, workspaceId?: string): Promise<QuickEditManifestRecord[]> {
    const result = workspaceId
      ? await this.db.query('select * from edit_manifests where workspace_id = $1 order by revision desc', [workspaceId])
      : await this.db.query('select * from edit_manifests where project_id = $1 order by revision desc', [projectId]);
    return result.rows.map((row) => mapRecord(row as Record<string, unknown>));
  }

  async getManifest(projectId: string, manifestId: string, workspaceId?: string): Promise<QuickEditManifestRecord | null> {
    const result = workspaceId
      ? await this.db.query('select * from edit_manifests where workspace_id = $1 and id = $2', [workspaceId, manifestId])
      : await this.db.query('select * from edit_manifests where project_id = $1 and id = $2', [projectId, manifestId]);
    return result.rows[0] ? mapRecord(result.rows[0] as Record<string, unknown>) : null;
  }

  /** Persist a freshly planned V1 manifest as the current editable version. */
  async createPlannedManifest(input: { projectId?: string; workspaceId?: string; manifest: EditManifestV0; createdBy?: string }): Promise<QuickEditManifestRecord> {
    if ((input.projectId === undefined) === (input.workspaceId === undefined)) throw new Error('VIDEO_ADJUSTMENT_OWNER_REQUIRED');
    validateEditManifest(input.manifest);
    if (input.projectId && input.manifest.projectId !== input.projectId) throw new Error('VIDEO_MANIFEST_PROJECT_SCOPE_MISMATCH');
    if (input.workspaceId && input.manifest.workspaceId !== input.workspaceId) throw new Error('VIDEO_MANIFEST_WORKSPACE_SCOPE_MISMATCH');
    const ownerValue = input.projectId || input.workspaceId!; const client = await this.db.connect();
    try {
      await client.query('begin');
      const scopeColumn = input.projectId ? 'project_id' : 'workspace_id';
      await client.query(`update edit_manifests set status = 'SUPERSEDED' where ${scopeColumn} = $1 and status = 'PERSISTED'`, [ownerValue]);
      const revision = Number((await client.query<{ revision: number }>(`select coalesce(max(revision), 0) + 1 as revision from edit_manifests where ${scopeColumn} = $1`, [ownerValue])).rows[0]?.revision || 1);
      const id = `manifest-${randomUUID()}`;
      const result = await client.query('insert into edit_manifests (id, project_id, workspace_id, revision, schema_version, manifest, manifest_digest, status, created_by, edit_operations) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *', [id, input.projectId || null, input.workspaceId || null, revision, 'EDIT_MANIFEST_V0', input.manifest, digestEditManifest(input.manifest), 'PERSISTED', input.createdBy?.trim() || 'operator', []]);
      await client.query('commit');
      return mapRecord(result.rows[0] as Record<string, unknown>);
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async createVersion(input: CreateQuickEditVersionInput): Promise<QuickEditManifestRecord> {
    if ((input.projectId === undefined) === (input.workspaceId === undefined)) throw new Error('VIDEO_ADJUSTMENT_OWNER_REQUIRED');
    const operations = parseQuickEditOperations(input.operations);
    if (!input.createdBy.trim()) throw new Error('createdBy is required');
    const inputDigest = digest({ projectId: input.projectId || input.workspaceId || '', parentManifestId: input.parentManifestId, operations, createdBy: input.createdBy.trim() });
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const ownerColumn = input.workspaceId ? 'workspace_id' : 'project_id';
      const ownerId = input.workspaceId || input.projectId!;
      const persistedWorkspaceId = input.workspaceId || `workspace-project-${input.projectId}`;
      if (input.projectId) await client.query("insert into video_workspaces (id, type, project_id) values ($1, 'PROJECT', $2) on conflict (project_id) do nothing", [persistedWorkspaceId, input.projectId]);
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`contentos:video-manifest:${ownerId}`]);
      if (input.idempotencyKey) {
        const existing = await client.query(`select * from edit_manifests where ${ownerColumn} = $1 and idempotency_key = $2`, [ownerId, input.idempotencyKey]);
        if (existing.rows[0]) {
          const row = existing.rows[0] as Record<string, unknown>;
          if (String(row.input_digest) !== inputDigest) throw new Error('VIDEO_MANIFEST_IDEMPOTENCY_CONFLICT');
          await client.query('commit');
          return mapRecord(row);
        }
      }
      const parentResult = await client.query(`select * from edit_manifests where id = $1 and ${ownerColumn} = $2 for update`, [input.parentManifestId, ownerId]);
      const parent = parentResult.rows[0] as Record<string, unknown> | undefined;
      if (!parent) throw new Error('VIDEO_MANIFEST_PARENT_NOT_FOUND');
      if (String(parent.status) !== 'PERSISTED') throw new Error('VIDEO_MANIFEST_PARENT_NOT_CURRENT');
      const parentValue = parent.manifest as EditManifestV0;
      validateEditManifest(parentValue);
      const sourceIds = [...new Set(parentValue.timeline.map((clip) => clip.assetId))];
      const hasLocalSources = !input.workspaceId && sourceIds.some((id) => id.startsWith('local-'));
      if (hasLocalSources) {
        const sourceRootId = parentValue.metadata?.localMediaSourceRootId;
        const persistedPool = sourceRootId && this.localMedia ? await this.localMedia.getLatestScan(input.projectId!, sourceRootId) : null;
        const indexedPool = this.localMedia ? await this.localMedia.listIndex(input.projectId!, {}) : [];
        const indexedAssets = indexedPool.filter((file) => file.available).map((file) => ({ id: `${persistedPool?.sourceRootId || sourceIds[0]?.split(':', 1)[0] || 'local'}:${file.relativePath}`, durationMs: file.durationMs, sourcePath: file.sourcePath, originalName: file.fileName, tags: file.tags, metadata: { width: file.width, height: file.height, format: file.format, category: file.category, usageCount: file.usageCount, recentUsageCount: file.recentUsageCount, lastUsedAt: file.lastUsedAt }, usageCount: file.usageCount, recentUsageCount: file.recentUsageCount, lastUsedAt: file.lastUsedAt }));
        const projectIds = sourceIds.filter((id) => !id.startsWith('local-'));
        const projectPool = projectIds.length > 0 ? await this.assets.listReadyVideoAssets(input.projectId!) : [];
        const projectAssets = projectPool.map((asset) => ({ id: asset.id, durationMs: sourceDuration(asset, asset.id), sourcePath: asset.storageKey, originalName: typeof asset.metadata.originalName === 'string' ? asset.metadata.originalName : asset.storageKey, tags: Array.isArray(asset.metadata.tags) ? asset.metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [], metadata: asset.metadata }));
        const pool = [...(indexedAssets.length > 0 ? indexedAssets : parentValue.timeline.filter((clip) => clip.assetId.startsWith('local-')).map((clip) => ({ id: clip.assetId, durationMs: Math.max(clip.sourceInMs + clip.durationMs, clip.durationMs), sourcePath: clip.sourcePath }))), ...projectAssets];
        const localSources = new Map(pool.map((asset) => [asset.id, asset]));
        const next = applyQuickEditOperations(parentValue, operations, pool);
        next.timeline = next.timeline.map((clip) => { const source = localSources.get(clip.assetId); if (!source) throw new Error(`VIDEO_MANIFEST_SOURCE_UNAVAILABLE: ${clip.assetId}`); if (clip.sourceInMs + clip.durationMs > source.durationMs) throw new Error(`VIDEO_MANIFEST_CLIP_OUT_OF_BOUNDS: ${clip.assetId}`); return { ...clip, sourcePath: source.sourcePath }; });
        validateEditManifest(next);
        const revisionResult = await client.query<{ revision: number }>(`select coalesce(max(revision), 0) + 1 as revision from edit_manifests where ${ownerColumn} = $1`, [ownerId]);
        const revision = Number(revisionResult.rows[0]?.revision || 1);
        await client.query("update edit_manifests set status = 'SUPERSEDED' where id = $1 and status = 'PERSISTED'", [input.parentManifestId]);
        const id = `manifest-${randomUUID()}`;
        const inserted = await client.query('insert into edit_manifests (id, project_id, workspace_id, revision, schema_version, manifest, manifest_digest, status, parent_manifest_id, edit_operations, created_by, idempotency_key, input_digest) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *', [id, input.projectId || null, persistedWorkspaceId, revision, 'EDIT_MANIFEST_V0', next, digestEditManifest(next), 'PERSISTED', input.parentManifestId, JSON.stringify(operations), input.createdBy.trim(), input.idempotencyKey || null, inputDigest]);
        await client.query('commit'); return mapRecord(inserted.rows[0] as Record<string, unknown>);
      }
      const sourceRows = input.workspaceId ? await this.assets.listReadyWorkspaceAssets(input.workspaceId, 'VIDEO') : await this.assets.listReadySourceAssets(input.projectId!, sourceIds, 'VIDEO');
      if (!input.workspaceId && sourceRows.length !== sourceIds.length) throw new Error('VIDEO_MANIFEST_SOURCE_UNAVAILABLE');
      const allSources = sourceRows.length > 0 && input.workspaceId ? sourceRows : await this.assets.listReadyVideoAssets(input.projectId!);
      const sourceById = new Map(allSources.map((asset) => [asset.id, asset]));
      const next = applyQuickEditOperations(parentValue, operations, allSources.map((asset) => ({ id: asset.id, durationMs: sourceDuration(asset, asset.id), sourcePath: asset.storageKey, originalName: typeof asset.metadata.originalName === 'string' ? asset.metadata.originalName : asset.storageKey, tags: Array.isArray(asset.metadata.tags) ? asset.metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [], metadata: asset.metadata })));
      next.timeline = next.timeline.map((clip) => {
        const source = sourceById.get(clip.assetId);
        if (!source) throw new Error(`VIDEO_MANIFEST_SOURCE_UNAVAILABLE: ${clip.assetId}`);
        const duration = sourceDuration(source, clip.assetId);
        if (clip.sourceInMs + clip.durationMs > duration) throw new Error(`VIDEO_MANIFEST_CLIP_OUT_OF_BOUNDS: ${clip.assetId}`);
        return { ...clip, sourcePath: source.storageKey };
      });
      if (next.audio.voiceAssetId) {
        const voice = input.workspaceId ? await this.assets.getReadyWorkspaceAsset(input.workspaceId, next.audio.voiceAssetId, 'AUDIO', 'VOICE') : await this.assets.getReadySourceAsset(input.projectId!, next.audio.voiceAssetId, 'AUDIO');
        if (!voice) throw new Error('VIDEO_MANIFEST_VOICE_UNAVAILABLE');
        next.audio = { ...next.audio, voicePath: voice.storageKey };
      }
      validateEditManifest(next);
      const revisionResult = await client.query<{ revision: number }>(`select coalesce(max(revision), 0) + 1 as revision from edit_manifests where ${ownerColumn} = $1`, [ownerId]);
      const revision = Number(revisionResult.rows[0]?.revision || 1);
      await client.query("update edit_manifests set status = 'SUPERSEDED' where id = $1 and status = 'PERSISTED'", [input.parentManifestId]);
      const id = `manifest-${randomUUID()}`;
      const inserted = await client.query('insert into edit_manifests (id, project_id, workspace_id, revision, schema_version, manifest, manifest_digest, status, parent_manifest_id, edit_operations, created_by, idempotency_key, input_digest) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *', [id, input.projectId || null, persistedWorkspaceId, revision, 'EDIT_MANIFEST_V0', next, digestEditManifest(next), 'PERSISTED', input.parentManifestId, JSON.stringify(operations), input.createdBy.trim(), input.idempotencyKey || null, inputDigest]);
      await client.query('commit');
      return mapRecord(inserted.rows[0] as Record<string, unknown>);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }
}

/** @deprecated Use VideoAdjustmentService. */
export { VideoAdjustmentService as VideoQuickEditService };
