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
    projectId: String(row.project_id),
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
  };
}

export class AssetCatalogService {
  constructor(private readonly db: Pool) {}

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

  async listProjectAssets(projectId: string): Promise<AssetSummaryV0[]> {
    const result = await this.db.query('select a.* from assets a join project_assets pa on pa.asset_id = a.id and pa.project_id = $1 order by a.created_at', [projectId]);
    return result.rows.map((row) => {
      const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
      return { id: String(row.id), kind: String(row.kind) as AssetSummaryV0['kind'], lifecycle: String(row.lifecycle) as AssetSummaryV0['lifecycle'], byteSize: Number(row.byte_size), checksum: String(row.checksum), originalName: typeof metadata.originalName === 'string' ? metadata.originalName : String(row.storage_key).split('/').pop() || 'asset', metadata: safeMetadata(row) };
    });
  }

  async getReadyAssetContent(projectId: string, assetId: string): Promise<ReadyAssetContent | null> {
    const result = await this.db.query('select * from assets where project_id = $1 and id = $2 and lifecycle = $3', [projectId, assetId, 'READY']);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
    return { id: String(row.id), kind: String(row.kind) as AssetSummaryV0['kind'], lifecycle: 'READY', byteSize: Number(row.byte_size), checksum: String(row.checksum), originalName: typeof metadata.originalName === 'string' ? metadata.originalName : String(row.storage_key).split('/').pop() || 'asset', metadata: safeMetadata(row), storageKey: String(row.storage_key) };
  }
}
