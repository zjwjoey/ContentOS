import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AssetCatalogService } from '../../asset/src/index.js';
import { buildRandomMontageManifest } from './planner.js';
import type { EditManifestV0 } from '../../../contracts/src/index.js';
import type { VideoAdjustmentService, QuickEditManifestRecord } from './quick-edit-service.js';
import type { VideoService } from './video-service.js';
import type { JobRecord } from '../../job/src/index.js';

export interface StandaloneQuickEditSession {
  id: string;
  workspaceId: string;
  sourceAssetIds: string[];
  voiceAssetId: string | null;
  plannerType: 'RANDOM_MONTAGE';
  seed: number;
  targetDurationMs: number | null;
  minClipDurationMs: number;
  maxClipDurationMs: number;
  width: 1080;
  height: 1920;
  fps: 30;
  transitionPolicy: 'CUT';
  currentManifestId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStandaloneQuickEditInput { sourceAssetIds: string[]; voiceAssetId?: string; seed?: number; targetDurationMs?: number; minClipDurationMs?: number; maxClipDurationMs?: number; }
export interface UpdateStandaloneQuickEditInput { seed?: number; targetDurationMs?: number | null; minClipDurationMs?: number; maxClipDurationMs?: number; }

function mapSession(row: Record<string, unknown>, sourceAssetIds: string[]): StandaloneQuickEditSession {
  return { id: String(row.id), workspaceId: String(row.workspace_id), sourceAssetIds, voiceAssetId: row.voice_asset_id ? String(row.voice_asset_id) : null, plannerType: 'RANDOM_MONTAGE', seed: Number(row.seed), targetDurationMs: row.target_duration_ms == null ? null : Number(row.target_duration_ms), minClipDurationMs: Number(row.min_clip_duration_ms), maxClipDurationMs: Number(row.max_clip_duration_ms), width: 1080, height: 1920, fps: 30, transitionPolicy: 'CUT', currentManifestId: row.current_manifest_id ? String(row.current_manifest_id) : null, createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() };
}

export class StandaloneQuickEditService {
  constructor(private readonly db: Pool, private readonly assets: AssetCatalogService, private readonly adjustments: VideoAdjustmentService, private readonly video: VideoService) {}

  async create(input: CreateStandaloneQuickEditInput): Promise<StandaloneQuickEditSession> {
    const sourceAssetIds = [...new Set(input.sourceAssetIds.map((id) => id.trim()).filter(Boolean))];
    if (sourceAssetIds.length > 128) throw new Error('STANDALONE_SOURCE_ASSETS_TOO_MANY');
    const seed = input.seed ?? Math.floor(Math.random() * 2_147_483_647);
    const minClipDurationMs = input.minClipDurationMs ?? 2_000;
    const maxClipDurationMs = input.maxClipDurationMs ?? 5_000;
    if (!Number.isInteger(seed) || !Number.isInteger(minClipDurationMs) || !Number.isInteger(maxClipDurationMs) || maxClipDurationMs < minClipDurationMs) throw new Error('STANDALONE_PLANNER_SETTINGS_INVALID');
    const workspaceId = `workspace-standalone-${randomUUID()}`;
    const sessionId = `quick-edit-${randomUUID()}`;
    const client = await this.db.connect();
    try {
      await client.query('begin');
      await client.query('insert into video_workspaces (id, type, project_id) values ($1, $2, null)', [workspaceId, 'STANDALONE']);
      const assetCheck = await client.query('select id from assets where id = any($1::text[]) and lifecycle = $2 and kind = $3 and project_id is null', [sourceAssetIds, 'READY', 'VIDEO']);
      if (assetCheck.rows.length !== sourceAssetIds.length) throw new Error('STANDALONE_SOURCE_ASSET_INVALID');
      for (const assetId of sourceAssetIds) await client.query('insert into video_workspace_assets (workspace_id, asset_id, role) values ($1, $2, $3)', [workspaceId, assetId, 'SOURCE']);
      if (input.voiceAssetId) {
        const voice = await client.query('select id from assets where id = $1 and lifecycle = $2 and kind = $3 and project_id is null', [input.voiceAssetId, 'READY', 'AUDIO']);
        if (!voice.rows[0]) throw new Error('STANDALONE_VOICE_ASSET_INVALID');
        await client.query('insert into video_workspace_assets (workspace_id, asset_id, role) values ($1, $2, $3)', [workspaceId, input.voiceAssetId, 'VOICE']);
      }
      const result = await client.query('insert into video_quick_edit_sessions (id, workspace_id, planner_type, seed, target_duration_ms, min_clip_duration_ms, max_clip_duration_ms, voice_asset_id) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *', [sessionId, workspaceId, 'RANDOM_MONTAGE', seed, input.targetDurationMs ?? null, minClipDurationMs, maxClipDurationMs, input.voiceAssetId ?? null]);
      await client.query('commit');
      return mapSession(result.rows[0] as Record<string, unknown>, sourceAssetIds);
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async get(id: string): Promise<StandaloneQuickEditSession | null> {
    const result = await this.db.query('select s.*, coalesce(array_agg(wa.asset_id) filter (where wa.role = $2), array[]::text[]) as source_asset_ids from video_quick_edit_sessions s left join video_workspace_assets wa on wa.workspace_id = s.workspace_id where s.id = $1 group by s.id', [id, 'SOURCE']);
    return result.rows[0] ? mapSession(result.rows[0] as Record<string, unknown>, (result.rows[0] as Record<string, unknown>).source_asset_ids as string[] || []) : null;
  }

  async plan(id: string): Promise<QuickEditManifestRecord> {
    const session = await this.get(id);
    if (!session) throw new Error('STANDALONE_QUICK_EDIT_NOT_FOUND');
    if (session.currentManifestId) {
      const existing = await this.adjustments.getManifest('', session.currentManifestId, session.workspaceId);
      if (existing) return existing;
    }
    const sources = await this.assets.listReadyWorkspaceAssets(session.workspaceId, 'VIDEO');
    if (sources.length === 0) throw new Error('STANDALONE_SOURCE_ASSET_INVALID');
    const voice = session.voiceAssetId
      ? await this.assets.getReadyWorkspaceAsset(session.workspaceId, session.voiceAssetId, 'AUDIO', 'VOICE')
      : (await this.assets.listReadyWorkspaceAssets(session.workspaceId, 'AUDIO', 'VOICE'))[0] || null;
    const voiceAssetId = voice?.id || session.voiceAssetId || undefined;
    const voiceDuration = voice ? Number(voice.metadata.durationMs) : 0;
    const targetDurationMs = session.targetDurationMs ?? voiceDuration;
    if (!Number.isFinite(targetDurationMs) || targetDurationMs <= 0) throw new Error('STANDALONE_VOICE_DURATION_REQUIRED');
    const manifest = buildRandomMontageManifest({ workspaceId: session.workspaceId, seed: session.seed, assets: sources.map((asset) => ({ id: asset.id, storageKey: asset.storageKey, sourcePath: asset.storageKey, durationMs: Number(asset.metadata.durationMs) })), targetDurationMs, minClipDurationMs: session.minClipDurationMs, maxClipDurationMs: session.maxClipDurationMs, ...(voiceAssetId ? { voiceAssetId } : {}) });
    const revision = Number((await this.db.query<{ revision: number }>('select coalesce(max(revision), 0) + 1 as revision from edit_manifests where workspace_id = $1', [session.workspaceId])).rows[0]?.revision || 1);
    const manifestId = `manifest-${randomUUID()}`;
    const inserted = await this.db.query('insert into edit_manifests (id, project_id, workspace_id, revision, schema_version, manifest, manifest_digest, status) values ($1, null, $2, $3, $4, $5, $6, $7) returning *', [manifestId, session.workspaceId, revision, 'EDIT_MANIFEST_V0', manifest, null, 'PERSISTED']);
    await this.db.query('update video_quick_edit_sessions set current_manifest_id = $2, updated_at = now() where id = $1', [id, manifestId]);
    if (!session.voiceAssetId && voiceAssetId) await this.db.query('update video_quick_edit_sessions set voice_asset_id = $2, updated_at = now() where id = $1', [id, voiceAssetId]);
    return (await this.adjustments.getManifest('', manifestId, session.workspaceId)) || (inserted.rows[0] as QuickEditManifestRecord);
  }

  async setVoiceAsset(id: string, assetId: string): Promise<StandaloneQuickEditSession> {
    const session = await this.get(id);
    if (!session) throw new Error('STANDALONE_QUICK_EDIT_NOT_FOUND');
    if (session.currentManifestId) throw new Error('STANDALONE_PLANNER_LOCKED');
    const voice = await this.assets.getReadyWorkspaceAsset(session.workspaceId, assetId, 'AUDIO', 'VOICE');
    if (!voice) throw new Error('STANDALONE_VOICE_ASSET_INVALID');
    await this.db.query('update video_quick_edit_sessions set voice_asset_id = $2, updated_at = now() where id = $1 and workspace_id = $3', [id, assetId, session.workspaceId]);
    return (await this.get(id))!;
  }

  async updateSettings(id: string, input: UpdateStandaloneQuickEditInput): Promise<StandaloneQuickEditSession> {
    const session = await this.get(id);
    if (!session) throw new Error('STANDALONE_QUICK_EDIT_NOT_FOUND');
    if (session.currentManifestId) throw new Error('STANDALONE_PLANNER_LOCKED');
    const seed = input.seed ?? session.seed;
    const minClipDurationMs = input.minClipDurationMs ?? session.minClipDurationMs;
    const maxClipDurationMs = input.maxClipDurationMs ?? session.maxClipDurationMs;
    const targetDurationMs = input.targetDurationMs === undefined ? session.targetDurationMs : input.targetDurationMs;
    if (!Number.isInteger(seed) || !Number.isInteger(minClipDurationMs) || minClipDurationMs <= 0 || !Number.isInteger(maxClipDurationMs) || maxClipDurationMs < minClipDurationMs || (targetDurationMs !== null && (!Number.isInteger(targetDurationMs) || targetDurationMs <= 0))) throw new Error('STANDALONE_PLANNER_SETTINGS_INVALID');
    const result = await this.db.query('update video_quick_edit_sessions set seed = $2, target_duration_ms = $3, min_clip_duration_ms = $4, max_clip_duration_ms = $5, updated_at = now() where id = $1 and current_manifest_id is null returning *', [id, seed, targetDurationMs, minClipDurationMs, maxClipDurationMs]);
    if (!result.rows[0]) throw new Error('STANDALONE_PLANNER_LOCKED');
    return (await this.get(id))!;
  }

  async adjust(id: string, operations: Parameters<VideoAdjustmentService['createVersion']>[0]['operations'], createdBy = 'operator'): Promise<QuickEditManifestRecord> {
    const session = await this.get(id);
    if (!session || !session.currentManifestId) throw new Error('STANDALONE_MANIFEST_REQUIRED');
    const revised = await this.adjustments.createVersion({ workspaceId: session.workspaceId, parentManifestId: session.currentManifestId, operations, createdBy });
    await this.db.query('update video_quick_edit_sessions set current_manifest_id = $2, updated_at = now() where id = $1 and workspace_id = $3 and current_manifest_id = $4', [id, revised.id, session.workspaceId, session.currentManifestId]);
    return revised;
  }

  async render(id: string): Promise<JobRecord> {
    const session = await this.get(id);
    if (!session || !session.currentManifestId) throw new Error('STANDALONE_MANIFEST_REQUIRED');
    return this.video.createManifestRenderJobForWorkspace(session.workspaceId, session.currentManifestId);
  }
}
