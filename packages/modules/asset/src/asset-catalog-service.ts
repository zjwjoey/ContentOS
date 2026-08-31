import type { Pool } from 'pg';
import type { AssetSummaryV0 } from '../../../contracts/src/index.js';

export interface PublishableAsset {
  id: string;
  projectId: string;
  kind: 'VIDEO_RENDER';
  checksum: string;
  lifecycle: 'READY';
  storageKey: string;
  byteSize: number;
  metadata: Record<string, unknown>;
}

export type SourceAssetKind = 'VIDEO' | 'AUDIO';

export interface ReadySourceAsset {
  id: string;
  projectId: string;
  kind: SourceAssetKind;
  storageKey: string;
  metadata: Record<string, unknown>;
}

export interface ReadyAssetContent extends AssetSummaryV0 { storageKey: string; }
export interface ProjectAssetReference { id: string; projectId: string; kind: string; lifecycle: string; storageKey: string; }

function mapAsset(row: Record<string, unknown>): PublishableAsset {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: 'VIDEO_RENDER',
    checksum: String(row.checksum),
    lifecycle: 'READY',
    storageKey: String(row.storage_key),
    byteSize: Number(row.byte_size),
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {},
  };
}

function mapSourceAsset(row: Record<string, unknown>): ReadySourceAsset {
  return {
    id: String(row.id),
    projectId: row.project_id ? String(row.project_id) : '',
    kind: String(row.kind) as SourceAssetKind,
    storageKey: String(row.storage_key),
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {},
  };
}

function safeMetadata(row: Record<string, unknown>): AssetSummaryV0['metadata'] {
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
  return {
    ...(typeof metadata.durationMs === 'number' ? { durationMs: metadata.durationMs } : {}),
    ...(typeof metadata.width === 'number' ? { width: metadata.width } : {}),
    ...(typeof metadata.height === 'number' ? { height: metadata.height } : {}),
    ...(typeof metadata.format === 'string' ? { format: metadata.format } : {}),
    ...(Array.isArray(metadata.tags) ? { tags: metadata.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 64) } : {}),
    ...(typeof metadata.category === 'string' ? { category: metadata.category } : {}),
    ...(typeof metadata.notes === 'string' ? { notes: metadata.notes.slice(0, 20_000) } : {}),
  };
}

export class AssetCatalogService {
  constructor(private readonly db: Pool) {}

  async getProjectAsset(projectId: string, assetId: string): Promise<ProjectAssetReference | null> {
    const result = await this.db.query('select id, project_id, kind, lifecycle, storage_key from assets where project_id = $1 and id = $2', [projectId, assetId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), projectId: String(row.project_id), kind: String(row.kind), lifecycle: String(row.lifecycle), storageKey: String(row.storage_key) } : null;
  }

  async listPublishable(projectId: string): Promise<PublishableAsset[]> {
    const result = await this.db.query('select * from assets where project_id = $1 and kind = $2 and lifecycle = $3 order by created_at desc, id desc', [projectId, 'VIDEO_RENDER', 'READY']);
    return result.rows.map((row) => mapAsset(row as Record<string, unknown>));
  }

  async getPublishableAsset(projectId: string, assetId: string): Promise<PublishableAsset | null> {
    const result = await this.db.query('select * from assets where project_id = $1 and id = $2 and kind = $3 and lifecycle = $4', [projectId, assetId, 'VIDEO_RENDER', 'READY']);
    return result.rows[0] ? mapAsset(result.rows[0] as Record<string, unknown>) : null;
  }

  async listReadySourceAssets(projectId: string, assetIds: string[], kind: SourceAssetKind): Promise<ReadySourceAsset[]> {
    if (assetIds.length === 0) return [];
    const result = await this.db.query('select a.id, pa.project_id, a.kind, a.storage_key, a.metadata from assets a join project_assets pa on pa.asset_id = a.id and pa.project_id = $1 and pa.role = $5 where a.id = any($2::text[]) and a.kind = $3 and a.lifecycle = $4', [projectId, assetIds, kind, 'READY', 'SOURCE']);
    return result.rows.map((row) => mapSourceAsset(row as Record<string, unknown>));
  }

  async getReadySourceAsset(projectId: string, assetId: string, kind: SourceAssetKind): Promise<ReadySourceAsset | null> {
    const result = await this.db.query('select a.id, pa.project_id, a.kind, a.storage_key, a.metadata from assets a join project_assets pa on pa.asset_id = a.id and pa.project_id = $1 and pa.role = $5 where a.id = $2 and a.kind = $3 and a.lifecycle = $4', [projectId, assetId, kind, 'READY', 'SOURCE']);
    return result.rows[0] ? mapSourceAsset(result.rows[0] as Record<string, unknown>) : null;
  }

  async listReadyVideoAssets(projectId: string): Promise<ReadySourceAsset[]> {
    const result = await this.db.query('select a.id, pa.project_id, a.kind, a.storage_key, a.metadata from assets a join project_assets pa on pa.asset_id = a.id and pa.project_id = $1 and pa.role = $2 where a.kind = $3 and a.lifecycle = $4 order by a.created_at, a.id', [projectId, 'SOURCE', 'VIDEO', 'READY']);
    return result.rows.map((row) => mapSourceAsset(row as Record<string, unknown>));
  }

  async listReadyWorkspaceAssets(workspaceId: string, kind: SourceAssetKind, role: 'SOURCE' | 'VOICE' = 'SOURCE'): Promise<ReadySourceAsset[]> {
    const result = await this.db.query('select a.id, a.project_id, a.kind, a.storage_key, a.metadata from assets a join video_workspace_assets wa on wa.asset_id = a.id and wa.workspace_id = $1 and wa.role = $2 where a.kind = $3 and a.lifecycle = $4 order by a.created_at, a.id', [workspaceId, role, kind, 'READY']);
    return result.rows.map((row) => mapSourceAsset(row as Record<string, unknown>));
  }

  async getReadyWorkspaceAsset(workspaceId: string, assetId: string, kind: SourceAssetKind, role: 'SOURCE' | 'VOICE' = 'SOURCE'): Promise<ReadySourceAsset | null> {
    const result = await this.db.query('select a.id, a.project_id, a.kind, a.storage_key, a.metadata from assets a join video_workspace_assets wa on wa.asset_id = a.id and wa.workspace_id = $1 and wa.asset_id = $2 and wa.role = $3 where a.kind = $4 and a.lifecycle = $5', [workspaceId, assetId, role, kind, 'READY']);
    return result.rows[0] ? mapSourceAsset(result.rows[0] as Record<string, unknown>) : null;
  }

  async getReadyWorkspaceAssetContent(workspaceId: string, assetId: string): Promise<ReadyAssetContent | null> {
    const result = await this.db.query('select a.* from assets a join video_workspace_assets wa on wa.asset_id = a.id and wa.workspace_id = $1 and wa.asset_id = $2 where a.lifecycle = $3', [workspaceId, assetId, 'READY']);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
    return { id: String(row.id), kind: String(row.kind) as AssetSummaryV0['kind'], lifecycle: 'READY', byteSize: Number(row.byte_size), checksum: String(row.checksum), originalName: typeof metadata.originalName === 'string' ? metadata.originalName : String(row.storage_key).split('/').pop() || 'asset', metadata: safeMetadata(row), storageKey: String(row.storage_key) };
  }

  async listWorkspaceAssets(workspaceId: string): Promise<AssetSummaryV0[]> {
    const result = await this.db.query('select a.* from assets a join video_workspace_assets wa on wa.asset_id = a.id and wa.workspace_id = $1 order by a.created_at, a.id', [workspaceId]);
    return result.rows.map((row) => {
      const record = row as Record<string, unknown>;
      const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata as Record<string, unknown> : {};
      return { id: String(record.id), kind: String(record.kind) as AssetSummaryV0['kind'], lifecycle: String(record.lifecycle) as AssetSummaryV0['lifecycle'], byteSize: Number(record.byte_size), checksum: String(record.checksum), originalName: typeof metadata.originalName === 'string' ? metadata.originalName : String(record.storage_key).split('/').pop() || 'asset', metadata: safeMetadata(record) };
    });
  }

  async attachToWorkspace(workspaceId: string, assetId: string, role: 'SOURCE' | 'VOICE' | 'OUTPUT' = 'SOURCE'): Promise<void> {
    const result = await this.db.query('insert into video_workspace_assets (workspace_id, asset_id, role) select $1, id, $3 from assets where id = $2 and lifecycle = $4 on conflict do nothing returning asset_id', [workspaceId, assetId, role, 'READY']);
    if (!result.rowCount) throw new Error('VIDEO_WORKSPACE_ASSET_NOT_READY');
  }

  async listProjectAssets(projectId: string, filters: { kind?: string; tag?: string; query?: string } = {}): Promise<AssetSummaryV0[]> {
    const values: unknown[] = [projectId]; const clauses = ['pa.project_id = $1'];
    if (filters.kind) { values.push(filters.kind); clauses.push(`a.kind = $${values.length}`); }
    if (filters.tag) { values.push(filters.tag); clauses.push(`coalesce(a.metadata->'tags','[]'::jsonb) ? $${values.length}`); }
    if (filters.query) { values.push(`%${filters.query}%`); clauses.push(`coalesce(a.metadata->>'originalName','') ilike $${values.length}`); }
    const result = await this.db.query(`select a.* from assets a join project_assets pa on pa.asset_id = a.id where ${clauses.join(' and ')} order by a.created_at`, values);
    return result.rows.map((row) => {
      const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
      return { id: String(row.id), kind: String(row.kind) as AssetSummaryV0['kind'], lifecycle: String(row.lifecycle) as AssetSummaryV0['lifecycle'], byteSize: Number(row.byte_size), checksum: String(row.checksum), originalName: typeof metadata.originalName === 'string' ? metadata.originalName : String(row.storage_key).split('/').pop() || 'asset', metadata: safeMetadata(row) };
    });
  }

  async updateTags(projectId: string, assetId: string, input: { tags?: string[]; category?: string; notes?: string }): Promise<AssetSummaryV0 | null> {
    const current = await this.db.query('select a.* from assets a join project_assets pa on pa.asset_id = a.id and pa.project_id = $1 where a.id = $2', [projectId, assetId]);
    const row = current.rows[0] as Record<string, unknown> | undefined; if (!row) return null;
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? { ...(row.metadata as Record<string, unknown>) } : {};
    if (input.tags !== undefined) metadata.tags = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 64);
    if (input.category !== undefined) metadata.category = input.category.trim().slice(0, 200);
    if (input.notes !== undefined) metadata.notes = input.notes.slice(0, 20_000);
    const updated = await this.db.query('update assets set metadata = $1 where id = $2 returning *', [metadata, assetId]);
    const value = updated.rows[0] as Record<string, unknown>;
    const safe = safeMetadata(value);
    return { id: String(value.id), kind: String(value.kind) as AssetSummaryV0['kind'], lifecycle: String(value.lifecycle) as AssetSummaryV0['lifecycle'], byteSize: Number(value.byte_size), checksum: String(value.checksum), originalName: typeof metadata.originalName === 'string' ? metadata.originalName : String(value.storage_key).split('/').pop() || 'asset', metadata: safe };
  }

  async getReadyAssetContent(projectId: string, assetId: string): Promise<ReadyAssetContent | null> {
    const result = await this.db.query('select * from assets where project_id = $1 and id = $2 and lifecycle = $3', [projectId, assetId, 'READY']);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
    return { id: String(row.id), kind: String(row.kind) as AssetSummaryV0['kind'], lifecycle: 'READY', byteSize: Number(row.byte_size), checksum: String(row.checksum), originalName: typeof metadata.originalName === 'string' ? metadata.originalName : String(row.storage_key).split('/').pop() || 'asset', metadata: safeMetadata(row), storageKey: String(row.storage_key) };
  }
}
