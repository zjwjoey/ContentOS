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
export interface ProjectAssetReference { id: string; projectId: string; kind: string; lifecycle: string; storageKey: string; checksum: string; metadata: Record<string, unknown>; }

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
    const result = await this.db.query('select a.id, coalesce(pa.project_id, a.project_id) as project_id, a.kind, a.lifecycle, a.storage_key, a.checksum, a.metadata from assets a left join project_assets pa on pa.asset_id = a.id and pa.project_id = $1 where a.id = $2 and (a.project_id = $1 or pa.project_id = $1)', [projectId, assetId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const metadata = row?.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
    return row ? { id: String(row.id), projectId: String(row.project_id), kind: String(row.kind), lifecycle: String(row.lifecycle), storageKey: String(row.storage_key), checksum: String(row.checksum), metadata } : null;
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
    const roleClause = "pa.role in ('SOURCE','OUTPUT')";
    const result = await this.db.query(`select a.id, pa.project_id, a.kind, a.storage_key, a.metadata from assets a join project_assets pa on pa.asset_id = a.id and pa.project_id = $1 and ${roleClause} where a.id = any($2::text[]) and a.kind = $3 and a.lifecycle = $4`, [projectId, assetIds, kind, 'READY']);
    return result.rows.map((row) => mapSourceAsset(row as Record<string, unknown>));
  }

  async getReadySourceAsset(projectId: string, assetId: string, kind: SourceAssetKind): Promise<ReadySourceAsset | null> {
    const roleClause = "pa.role in ('SOURCE','OUTPUT')";
    const result = await this.db.query(`select a.id, pa.project_id, a.kind, a.storage_key, a.metadata from assets a join project_assets pa on pa.asset_id = a.id and pa.project_id = $1 and ${roleClause} where a.id = $2 and a.kind = $3 and a.lifecycle = $4`, [projectId, assetId, kind, 'READY']);
    return result.rows[0] ? mapSourceAsset(result.rows[0] as Record<string, unknown>) : null;
  }

  async listReadyVideoAssets(projectId: string): Promise<ReadySourceAsset[]> {
    const result = await this.db.query("select a.id, pa.project_id, a.kind, a.storage_key, a.metadata from assets a join project_assets pa on pa.asset_id = a.id and pa.project_id = $1 and pa.role in ('SOURCE','OUTPUT') where a.kind = $2 and a.lifecycle = $3 order by a.created_at, a.id", [projectId, 'VIDEO', 'READY']);
    return result.rows.map((row) => mapSourceAsset(row as Record<string, unknown>));
  }

  async listReadyGlobalVideoAssets(assetIds: string[] = []): Promise<ReadySourceAsset[]> {
    const values: unknown[] = ['VIDEO', 'READY'];
    const filter = assetIds.length > 0 ? ` and a.id = any($3::text[])` : '';
    if (assetIds.length > 0) values.push(assetIds);
    const result = await this.db.query(`select a.id, a.project_id, a.kind, a.storage_key, a.metadata from assets a where a.project_id is null and a.kind = $1 and a.lifecycle = $2${filter} order by a.created_at, a.id`, values);
    return result.rows.map((row) => mapSourceAsset(row as Record<string, unknown>));
  }

  async getReadyGlobalVideoAssetContent(assetId: string): Promise<ReadyAssetContent | null> {
    const result = await this.db.query("select * from assets where id = $1 and project_id is null and kind = 'VIDEO' and lifecycle = 'READY'", [assetId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
    return { id: String(row.id), kind: 'VIDEO', lifecycle: 'READY', byteSize: Number(row.byte_size), checksum: String(row.checksum), originalName: typeof metadata.originalName === 'string' ? metadata.originalName : String(row.storage_key).split('/').pop() || 'asset', metadata: safeMetadata(row), storageKey: String(row.storage_key) };
  }

  async archiveGlobalVideoAsset(assetId: string): Promise<boolean> {
    const references = await this.db.query('select id from video_edit_presets where intro_asset_id = $1 or outro_asset_id = $1 limit 1', [assetId]);
    if (references.rows[0]) throw new Error('VIDEO_BRANDING_ASSET_IN_USE');
    const result = await this.db.query("update assets set lifecycle = 'ARCHIVED' where id = $1 and project_id is null and kind = 'VIDEO' and lifecycle = 'READY' returning id", [assetId]);
    return Boolean(result.rows[0]);
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

  async listAssetLibrary(filters: { projectId?: string; workspaceId?: string; kind?: string; tag?: string; query?: string; includeArchived?: boolean; limit?: number; offset?: number }): Promise<{ items: Array<AssetSummaryV0 & { sourcePath: string; fingerprint: string; usage: { candidateCount: number; selectedCount: number; manualSelectCount: number; finalUseCount: number; jianyingUseCount: number; replaceCount: number; recentUseCount: number; lastUsedAt: string | null } }>; total: number; limit: number; offset: number }> {
    if (!filters.projectId && !filters.workspaceId) throw new Error('ASSET_LIBRARY_SCOPE_REQUIRED');
    const limit = Math.min(200, Math.max(1, Math.trunc(filters.limit || 50)));
    const offset = Math.max(0, Math.trunc(filters.offset || 0));
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (filters.projectId) { values.push(filters.projectId); clauses.push(`pa.project_id = $${values.length}`); }
    if (filters.workspaceId) { values.push(filters.workspaceId); clauses.push(`wa.workspace_id = $${values.length}`); }
    if (filters.kind) { values.push(filters.kind); clauses.push(`a.kind = $${values.length}`); }
    if (!filters.includeArchived) clauses.push("a.lifecycle = 'READY'");
    if (filters.tag) { values.push(filters.tag); clauses.push(`coalesce(a.metadata->'tags','[]'::jsonb) ? $${values.length}`); }
    if (filters.query) { values.push(`%${filters.query}%`); clauses.push(`coalesce(a.metadata->>'originalName','') ilike $${values.length}`); }
    const join = filters.projectId ? 'join project_assets pa on pa.asset_id=a.id' : 'join video_workspace_assets wa on wa.asset_id=a.id';
    const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
    const count = await this.db.query<{ total: number }>(`select count(distinct a.id)::int as total from assets a ${join} ${where}`, values);
    const pageValues = [...values, limit, offset];
    const usageJoin = filters.workspaceId ? `left join script_editing_v3_asset_usage_stats u on u.asset_id=a.id and u.workspace_id=$${values.length + 1}` : '';
    const usageValues = filters.workspaceId ? [...pageValues.slice(0, -2), filters.workspaceId, ...pageValues.slice(-2)] : pageValues;
    const result = await this.db.query(`select distinct a.*,${filters.workspaceId ? 'u.candidate_count,u.selected_count,u.manual_select_count,u.final_use_count,u.jianying_use_count,u.replace_count,u.recent_use_count,u.last_used_at,' : ''} a.storage_key as source_path from assets a ${join} ${usageJoin} ${where} order by a.created_at desc,a.id desc limit $${usageValues.length - 1} offset $${usageValues.length}`, usageValues);
    return { items: result.rows.map((row) => {
      const record = row as Record<string, unknown>;
      const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata as Record<string, unknown> : {};
      return { id: String(record.id), kind: String(record.kind) as AssetSummaryV0['kind'], lifecycle: String(record.lifecycle) as AssetSummaryV0['lifecycle'], byteSize: Number(record.byte_size), checksum: String(record.checksum), originalName: typeof metadata.originalName === 'string' ? metadata.originalName : String(record.storage_key).split('/').pop() || 'asset', metadata: safeMetadata(record), sourcePath: String(record.source_path || record.storage_key), fingerprint: String(record.checksum), usage: { candidateCount: Number(record.candidate_count || 0), selectedCount: Number(record.selected_count || 0), manualSelectCount: Number(record.manual_select_count || 0), finalUseCount: Number(record.final_use_count || 0), jianyingUseCount: Number(record.jianying_use_count || 0), replaceCount: Number(record.replace_count || 0), recentUseCount: Number(record.recent_use_count || 0), lastUsedAt: record.last_used_at ? new Date(String(record.last_used_at)).toISOString() : null } };
    }), total: Number(count.rows[0]?.total || 0), limit, offset };
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

  async getReadyDigitalHumanSubtitle(projectId: string, speechGenerationId: string, format: 'srt' | 'ass'): Promise<ReadyAssetContent | null> {
    const result = await this.db.query("select a.* from assets a join project_assets pa on pa.asset_id = a.id and pa.project_id = $1 where a.project_id = $1 and a.kind = 'TEXT' and a.lifecycle = 'READY' and a.metadata->'digitalHuman'->>'speechGenerationId' = $2 and a.metadata->>'format' = $3 order by a.created_at desc, a.id desc limit 1", [projectId, speechGenerationId, format]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
    return { id: String(row.id), kind: 'TEXT', lifecycle: 'READY', byteSize: Number(row.byte_size), checksum: String(row.checksum), originalName: typeof metadata.originalName === 'string' ? metadata.originalName : String(row.storage_key).split('/').pop() || 'asset', metadata: safeMetadata(row), storageKey: String(row.storage_key) };
  }

  async getReadyAssetForProviderStaging(projectId: string, assetId: string): Promise<ReadyAssetContent | null> {
    const result = await this.db.query("select a.* from assets a join project_assets pa on pa.asset_id = a.id and pa.project_id = $1 where a.id = $2 and a.project_id = $1 and a.kind in ('AUDIO','VIDEO') and a.lifecycle = 'READY'", [projectId, assetId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
    return { id: String(row.id), kind: String(row.kind) as AssetSummaryV0['kind'], lifecycle: 'READY', byteSize: Number(row.byte_size), checksum: String(row.checksum), originalName: typeof metadata.originalName === 'string' ? metadata.originalName : String(row.storage_key).split('/').pop() || 'asset', metadata: safeMetadata(row), storageKey: String(row.storage_key) };
  }
}
