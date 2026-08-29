import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AssetCatalogService } from '../../asset/src/index.js';
import { applyQuickEditOperations, parseQuickEditOperations, type QuickEditOperation } from './quick-edit.js';
import { validateEditManifest, type EditManifestV0 } from '../../../contracts/src/index.js';

export interface CreateQuickEditVersionInput {
  projectId: string;
  parentManifestId: string;
  operations: QuickEditOperation[];
  createdBy: string;
  idempotencyKey?: string;
}

export interface QuickEditManifestRecord {
  id: string;
  projectId: string;
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
    id: String(row.id), projectId: String(row.project_id), revision: Number(row.revision), status: row.status as QuickEditManifestRecord['status'],
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

export class VideoQuickEditService {
  constructor(private readonly db: Pool, private readonly assets: AssetCatalogService) {}

  async listManifests(projectId: string): Promise<QuickEditManifestRecord[]> {
    const result = await this.db.query('select * from edit_manifests where project_id = $1 order by revision desc', [projectId]);
    return result.rows.map((row) => mapRecord(row as Record<string, unknown>));
  }

  async getManifest(projectId: string, manifestId: string): Promise<QuickEditManifestRecord | null> {
    const result = await this.db.query('select * from edit_manifests where project_id = $1 and id = $2', [projectId, manifestId]);
    return result.rows[0] ? mapRecord(result.rows[0] as Record<string, unknown>) : null;
  }

  async createVersion(input: CreateQuickEditVersionInput): Promise<QuickEditManifestRecord> {
    const operations = parseQuickEditOperations(input.operations);
    if (!input.createdBy.trim()) throw new Error('createdBy is required');
    const inputDigest = digest({ projectId: input.projectId, parentManifestId: input.parentManifestId, operations, createdBy: input.createdBy.trim() });
    const client = await this.db.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`contentos:video-manifest:${input.projectId}`]);
      if (input.idempotencyKey) {
        const existing = await client.query('select * from edit_manifests where project_id = $1 and idempotency_key = $2', [input.projectId, input.idempotencyKey]);
        if (existing.rows[0]) {
          const row = existing.rows[0] as Record<string, unknown>;
          if (String(row.input_digest) !== inputDigest) throw new Error('VIDEO_MANIFEST_IDEMPOTENCY_CONFLICT');
          await client.query('commit');
          return mapRecord(row);
        }
      }
      const parentResult = await client.query('select * from edit_manifests where id = $1 and project_id = $2 for update', [input.parentManifestId, input.projectId]);
      const parent = parentResult.rows[0] as Record<string, unknown> | undefined;
      if (!parent) throw new Error('VIDEO_MANIFEST_PARENT_NOT_FOUND');
      if (String(parent.status) !== 'PERSISTED') throw new Error('VIDEO_MANIFEST_PARENT_NOT_CURRENT');
      const parentValue = parent.manifest as EditManifestV0;
      validateEditManifest(parentValue);
      const sourceIds = [...new Set(parentValue.timeline.map((clip) => clip.assetId))];
      const sourceRows = await this.assets.listReadySourceAssets(input.projectId, sourceIds, 'VIDEO');
      if (sourceRows.length !== sourceIds.length) throw new Error('VIDEO_MANIFEST_SOURCE_UNAVAILABLE');
      const sourceById = new Map(sourceRows.map((asset) => [asset.id, asset]));
      const next = applyQuickEditOperations(parentValue, operations);
      next.timeline = next.timeline.map((clip) => {
        const source = sourceById.get(clip.assetId);
        if (!source) throw new Error(`VIDEO_MANIFEST_SOURCE_UNAVAILABLE: ${clip.assetId}`);
        const duration = sourceDuration(source, clip.assetId);
        if (clip.sourceInMs + clip.durationMs > duration) throw new Error(`VIDEO_MANIFEST_CLIP_OUT_OF_BOUNDS: ${clip.assetId}`);
        return { ...clip, sourcePath: source.storageKey };
      });
      if (next.audio.voiceAssetId) {
        const voice = await this.assets.getReadySourceAsset(input.projectId, next.audio.voiceAssetId, 'AUDIO');
        if (!voice) throw new Error('VIDEO_MANIFEST_VOICE_UNAVAILABLE');
        next.audio = { ...next.audio, voicePath: voice.storageKey };
      }
      validateEditManifest(next);
      const revisionResult = await client.query<{ revision: number }>('select coalesce(max(revision), 0) + 1 as revision from edit_manifests where project_id = $1', [input.projectId]);
      const revision = Number(revisionResult.rows[0]?.revision || 1);
      await client.query("update edit_manifests set status = 'SUPERSEDED' where id = $1 and status = 'PERSISTED'", [input.parentManifestId]);
      const id = `manifest-${randomUUID()}`;
      const inserted = await client.query('insert into edit_manifests (id, project_id, revision, schema_version, manifest, status, parent_manifest_id, edit_operations, created_by, idempotency_key, input_digest) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *', [id, input.projectId, revision, 'EDIT_MANIFEST_V0', next, 'PERSISTED', input.parentManifestId, JSON.stringify(operations), input.createdBy.trim(), input.idempotencyKey || null, inputDigest]);
      await client.query('commit');
      return mapRecord(inserted.rows[0] as Record<string, unknown>);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }
}
