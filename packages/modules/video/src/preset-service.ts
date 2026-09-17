import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type PresetMode = 'SCRIPT' | 'RANDOM';
export interface VideoEditPreset {
  id: string; name: string; description: string; editModeDefault: PresetMode;
  minClipDurationMs: number; maxClipDurationMs: number; preferUnusedMedia: boolean;
  introAssetId: string | null; outroAssetId: string | null;
  canvas: { width: number; height: number; aspectRatio: '9:16' }; fps: number; isDefault: boolean;
  createdAt: string; updatedAt: string;
}
export interface VideoEditPresetInput {
  name: string | undefined; description?: string | undefined; editModeDefault?: PresetMode | undefined; minClipDurationMs?: number | undefined; maxClipDurationMs?: number | undefined;
  preferUnusedMedia?: boolean | undefined; introAssetId?: string | null | undefined; outroAssetId?: string | null | undefined;
  canvas?: { width: 1080; height: 1920; aspectRatio: '9:16' } | undefined; fps?: number | undefined;
}
function mapPreset(row: Record<string, unknown>): VideoEditPreset {
  const canvas = (row.canvas || {}) as Record<string, unknown>;
  return { id: String(row.id), name: String(row.name), description: String(row.description || ''), editModeDefault: String(row.edit_mode_default) as PresetMode, minClipDurationMs: Number(row.min_clip_duration_ms), maxClipDurationMs: Number(row.max_clip_duration_ms), preferUnusedMedia: Boolean(row.prefer_unused_media), introAssetId: row.intro_asset_id ? String(row.intro_asset_id) : null, outroAssetId: row.outro_asset_id ? String(row.outro_asset_id) : null, canvas: { width: Number(canvas.width || 1080), height: Number(canvas.height || 1920), aspectRatio: '9:16' }, fps: Number(row.fps || 30), isDefault: Boolean(row.is_default), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() };
}
export class VideoEditPresetService {
  constructor(private readonly db: Pool) {}
  async list(): Promise<VideoEditPreset[]> { const result = await this.db.query('select * from video_edit_presets order by is_default desc, name asc'); return result.rows.map((row) => mapPreset(row as Record<string, unknown>)); }
  async get(id: string): Promise<VideoEditPreset | null> { const result = await this.db.query('select * from video_edit_presets where id = $1', [id]); return result.rows[0] ? mapPreset(result.rows[0] as Record<string, unknown>) : null; }
  async getDefault(): Promise<VideoEditPreset | null> { const result = await this.db.query('select * from video_edit_presets where is_default order by name limit 1'); return result.rows[0] ? mapPreset(result.rows[0] as Record<string, unknown>) : null; }
  async create(input: VideoEditPresetInput): Promise<VideoEditPreset> { const id = `preset-${randomUUID()}`; const result = await this.db.query('insert into video_edit_presets (id,name,description,edit_mode_default,min_clip_duration_ms,max_clip_duration_ms,prefer_unused_media,intro_asset_id,outro_asset_id,canvas,fps) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *', [id, input.name?.trim() || '', input.description?.trim() || '', input.editModeDefault || 'SCRIPT', input.minClipDurationMs || 2000, input.maxClipDurationMs || 5000, input.preferUnusedMedia !== false, input.introAssetId || null, input.outroAssetId || null, JSON.stringify(input.canvas || { width: 1080, height: 1920, aspectRatio: '9:16' }), input.fps || 30]); return mapPreset(result.rows[0] as Record<string, unknown>); }
  async update(id: string, input: Partial<VideoEditPresetInput>): Promise<VideoEditPreset | null> { const current = await this.get(id); if (!current) return null; const result = await this.db.query('update video_edit_presets set name=$2,description=$3,edit_mode_default=$4,min_clip_duration_ms=$5,max_clip_duration_ms=$6,prefer_unused_media=$7,intro_asset_id=$8,outro_asset_id=$9,canvas=$10,fps=$11,updated_at=now() where id=$1 returning *', [id, input.name?.trim() || current.name, input.description?.trim() ?? current.description, input.editModeDefault || current.editModeDefault, input.minClipDurationMs || current.minClipDurationMs, input.maxClipDurationMs || current.maxClipDurationMs, input.preferUnusedMedia ?? current.preferUnusedMedia, input.introAssetId === undefined ? current.introAssetId : input.introAssetId, input.outroAssetId === undefined ? current.outroAssetId : input.outroAssetId, JSON.stringify(input.canvas || current.canvas), input.fps || current.fps]); return result.rows[0] ? mapPreset(result.rows[0] as Record<string, unknown>) : null; }
  async remove(id: string): Promise<boolean> { const result = await this.db.query('delete from video_edit_presets where id = $1 and is_default = false', [id]); return (result.rowCount || 0) > 0; }
  async setDefault(id: string): Promise<VideoEditPreset | null> { const client = await this.db.connect(); try { await client.query('begin'); const result = await client.query('select * from video_edit_presets where id = $1 for update', [id]); if (!result.rows[0]) { await client.query('rollback'); return null; } await client.query('update video_edit_presets set is_default = false, updated_at = now()'); const updated = await client.query('update video_edit_presets set is_default = true, updated_at = now() where id = $1 returning *', [id]); await client.query('commit'); return updated.rows[0] ? mapPreset(updated.rows[0] as Record<string, unknown>) : null; } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); } }
  async getProjectPreset(projectId: string): Promise<VideoEditPreset | null> { const result = await this.db.query('select v.* from video_edit_presets v join content_projects p on p.current_preset_id = v.id where p.id = $1', [projectId]); return result.rows[0] ? mapPreset(result.rows[0] as Record<string, unknown>) : this.getDefault(); }
  async applyToProject(projectId: string, presetId: string): Promise<VideoEditPreset | null> { const preset = await this.get(presetId); if (!preset) return null; await this.db.query('update content_projects set current_preset_id = $2, updated_at = now() where id = $1', [projectId, presetId]); return preset; }
}
