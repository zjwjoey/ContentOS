import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Pool } from 'pg';
import type { LocalStorageProvider } from '../../../infrastructure/storage/src/index.js';
import { probeMedia } from '../../../infrastructure/ffmpeg/src/index.js';
import { DEFAULT_PRESENTATION_SETTINGS_V1, normalizeControlledVisualTagsV3, normalizePresentationSettings, SCRIPT_EDITING_V3_SCORING_WEIGHTS, validateEditManifest, type CandidateV3, type ClipInstanceV3, type EditManifestV0, type EditOperationV3, type ManifestClip, type MaterialPoolHealthV3, type MaterialPoolItemV3, type MaterialPoolSnapshotV3, type PresentationSettingsV1, type SentenceEditingCardV3 } from '../../../contracts/src/index.js';
import { applyQuickEditOperations, digestEditManifest, type AdjustmentAsset } from './quick-edit.js';
import { planEditorialScript, type EditorialAudioPlanV1, type EditorialBrandingPlanV1, type EditorialPaceV1, type EditorialShotDensityV1, type EditorialTemplateV1 } from './editorial-plan.js';
import type { PlannerAsset, TimedScriptSentence } from './planner.js';
import type { HybridMediaService } from './hybrid-media.js';
import { segmentScriptSentences } from './sentence-segmenter.js';
import type { AssetVisualProfileV3 } from '../../../contracts/src/index.js';
import { createVisualQueryProvider, RuleVisualQueryProvider, type VisualQueryProvider } from './visual-query.js';
import { InMemoryMaterialSemanticIndex, QwenEmbeddingProvider, type EmbeddingProvider, type MaterialSemanticIndex } from './semantic-index.js';

type SentenceV3 = { id: string; index: number; text: string; startMs: number; endMs: number; durationMs: number };
type PoolRow = Record<string, unknown>;
type SessionSettingsV3 = Record<string, unknown>;

export async function ensureStandaloneWorkspace(db: Pool, workspaceId: string): Promise<void> {
  if (!workspaceId.trim()) throw new Error('WORKSPACE_REQUIRED');
  await db.query("insert into video_workspaces (id,type,project_id) values ($1,'STANDALONE',null) on conflict (id) do nothing", [workspaceId]);
}

export function materialSourceFingerprint(input: { fileSize?: number | null | undefined; modifiedAt?: string | null | undefined; durationMs: number }): string {
  const modifiedAt = input.modifiedAt ? new Date(String(input.modifiedAt)).toISOString() : '';
  return `${Number(input.fileSize || 0)}:${modifiedAt}:${Math.max(0, Math.round(input.durationMs))}`;
}

function tokens(value: string): string[] {
  const words = value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const word of [...words]) if (/^[\u3400-\u9fff]+$/u.test(word)) for (let size = 2; size <= Math.min(4, word.length); size += 1) for (let start = 0; start + size <= word.length; start += 1) words.push(word.slice(start, start + size));
  return [...new Set(words)];
}

function mapPoolItem(row: PoolRow): MaterialPoolItemV3 {
  const sourceRef = row.source_ref && typeof row.source_ref === 'object' ? row.source_ref as Record<string, unknown> : {};
  const sourceTags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const manualTags = Array.isArray(row.manual_tags) ? row.manual_tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const profile = row.ai_profile && typeof row.ai_profile === 'object' ? row.ai_profile as Record<string, unknown> : {};
  const profileTags = Array.isArray(profile.tags) ? profile.tags.flatMap((tag) => tag && typeof tag === 'object' && typeof (tag as Record<string, unknown>).tag === 'string' ? [String((tag as Record<string, unknown>).tag)] : []) : [];
  const itemTags = normalizeControlledVisualTagsV3([...sourceTags, ...manualTags]);
  const aiTags = normalizeControlledVisualTagsV3(profileTags);
  return { assetId: String(row.asset_id), sourcePath: String(row.source_path), fileName: String(row.file_name), durationMs: Number(row.duration_ms), width: Number(row.width || 0), height: Number(row.height || 0), ...(row.fps == null ? {} : { fps: Number(row.fps) }), ...(row.codec ? { codec: String(row.codec) } : {}), ...(row.file_size == null ? {} : { fileSize: Number(row.file_size) }), ...(row.modified_at ? { modifiedAt: new Date(String(row.modified_at)).toISOString() } : {}), ...(row.source_fingerprint ? { sourceFingerprint: String(row.source_fingerprint) } : {}), tags: itemTags, ...(aiTags.length ? { aiTags } : {}), ...(row.thumbnail_key ? { thumbnailUrl: `/api/v1/video/local-media/thumbnails/${encodeURIComponent(String(row.asset_id))}` } : {}), ...(row.availability ? { availability: String(row.availability) as NonNullable<MaterialPoolItemV3['availability']> } : {}), ...(row.ai_status ? { aiStatus: String(row.ai_status) as NonNullable<MaterialPoolItemV3['aiStatus']> } : {}), ...(row.disabled ? { disabled: true } : {}), ...(row.error_message ? { errorMessage: String(row.error_message) } : {}), ...(row.duplicate_of_asset_id ? { duplicateOfAssetId: String(row.duplicate_of_asset_id) } : {}), gold: Boolean(row.stats_gold ?? row.gold), historyUseCount: Number(sourceRef.usageCount || 0), jianyingUseCount: Number(row.jianying_use_count || sourceRef.jianyingUseCount || 0), candidateCount: Number(row.candidate_count || 0), selectedCount: Number(row.selected_count || 0), finalUseCount: Number(row.final_use_count || 0), contentOsFinalUseCount: Number(row.content_os_final_use_count || row.final_use_count || 0), replaceCount: Number(row.replace_count || 0), manualSelectCount: Number(row.manual_select_count || 0), recentUseCount: Number(row.recent_use_count || 0), ...(row.stats_last_used_at ? { lastUsedAt: new Date(String(row.stats_last_used_at)).toISOString() } : sourceRef.lastUsedAt ? { lastUsedAt: String(sourceRef.lastUsedAt) } : {}) };
}

function sentenceRows(value: unknown): SentenceV3[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const row = item as Record<string, unknown>;
    const startMs = Number(row.startMs ?? row.voiceStartMs ?? index * 3_000);
    const durationMs = Number(row.durationMs ?? (row.endMs !== undefined ? Number(row.endMs) - startMs : 3_000));
    return { id: String(row.id || `sentence-${index}`), index: Number(row.index ?? index), text: String(row.text || '').trim(), startMs: Math.max(0, startMs), endMs: Math.max(startMs + 1, Number(row.endMs ?? startMs + durationMs)), durationMs: Math.max(1, durationMs) };
  }).filter((row) => row.text);
}

function comparableScript(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function buildQueries(sentence: SentenceV3): string[] {
  const text = sentence.text.replace(/[，。！？；：、“”‘’（）()]/gu, ' ').trim();
  const subject = text.split(/\s+/u).filter(Boolean).slice(0, 5).join(' ');
  return [...new Set([subject, `${subject} 真实场景`, `${subject} 近景细节`, `${subject} 人物活动`, `${subject} 环境全景`].filter(Boolean))].slice(0, 5);
}

export function buildVisualQueriesV3(text: string): string[] { return buildQueries({ id: 'sentence', index: 0, text, startMs: 0, endMs: 3_000, durationMs: 3_000 }); }

function scoreCandidate(sentence: SentenceV3, item: MaterialPoolItemV3, profile?: AssetVisualProfileV3, queries = buildQueries(sentence), semanticScoreOverride?: number): CandidateV3 {
  const queryTokens = new Set(tokens(`${sentence.text} ${queries.join(' ')}`));
  const profileTags = profile?.tags.map((tag) => tag.tag) || [];
  const haystack = new Set(tokens(`${item.fileName} ${item.tags.join(' ')} ${profile?.summary || ''} ${profileTags.join(' ')}`));
  const matchingQueries = queries.filter((query) => tokens(query).some((token) => haystack.has(token)));
  const matched = [...queryTokens].filter((token) => haystack.has(token));
  const semanticScore = semanticScoreOverride === undefined ? (queryTokens.size ? Math.min(100, Math.round((matched.length / queryTokens.size) * 100)) : 0) : Math.min(100, Math.max(0, Math.round(semanticScoreOverride * 100)));
  const jianyingHistoryBonus = Math.min(SCRIPT_EDITING_V3_SCORING_WEIGHTS.jianyingHistoryBonus, Math.max(0, item.jianyingUseCount || 0));
  const contentOsHistoryBonus = Math.min(SCRIPT_EDITING_V3_SCORING_WEIGHTS.contentOsHistoryBonus, Math.max(0, item.contentOsFinalUseCount || item.finalUseCount || 0));
  const manualSelectBonus = Math.min(SCRIPT_EDITING_V3_SCORING_WEIGHTS.manualSelectBonus, Math.max(0, item.manualSelectCount || 0));
  const goldBonus = item.gold ? SCRIPT_EDITING_V3_SCORING_WEIGHTS.goldBonus : 0;
  const pixels = Math.max(0, item.width) * Math.max(0, item.height);
  const qualityBonus = pixels >= 2_000_000 ? SCRIPT_EDITING_V3_SCORING_WEIGHTS.qualityBonus : pixels >= 900_000 ? 2 : 0;
  const replacePenalty = Math.min(SCRIPT_EDITING_V3_SCORING_WEIGHTS.replacePenalty, Math.max(0, item.replaceCount || 0));
  const recentReusePenalty = Math.min(SCRIPT_EDITING_V3_SCORING_WEIGHTS.recentReusePenalty, Math.max(0, item.recentUseCount || 0));
  const reusePenalty = replacePenalty + recentReusePenalty;
  const historyBonus = jianyingHistoryBonus + contentOsHistoryBonus;
  const finalScore = semanticScore + jianyingHistoryBonus + contentOsHistoryBonus + manualSelectBonus + goldBonus + qualityBonus - reusePenalty;
  const maxSourceInMs = Math.max(0, item.durationMs - sentence.durationMs);
  const recommendedTimestampMs = Math.max(0, Math.min(item.durationMs, profile?.recommendedTimestampsMs[0] ?? Math.round(item.durationMs * 0.5)));
  const sourceInMs = Math.max(0, Math.min(maxSourceInMs, Math.round(recommendedTimestampMs - sentence.durationMs / 2)));
  return { assetId: item.assetId, recommendedTimestampMs, fileName: item.fileName, recommendedSourceInMs: sourceInMs, recommendedSourceOutMs: sourceInMs + sentence.durationMs, semanticScore, matchingQueries, visualEvidence: [...item.tags, ...profileTags].filter((tag) => matched.includes(tag.toLowerCase())).slice(0, 5), historyBonus, jianyingHistoryBonus, contentOsHistoryBonus, manualSelectBonus, goldBonus, qualityBonus, replacePenalty, recentReusePenalty, reusePenalty, ...(item.historyUseCount === undefined ? {} : { historyUseCount: item.historyUseCount }), ...(item.jianyingUseCount === undefined ? {} : { jianyingUseCount: item.jianyingUseCount }), ...(item.contentOsFinalUseCount === undefined ? {} : { contentOsFinalUseCount: item.contentOsFinalUseCount }), ...(item.gold === undefined ? {} : { gold: item.gold }), finalScore };
}

export function rankMaterialCandidateV3(input: { text: string; durationMs: number }, item: MaterialPoolItemV3): CandidateV3 { return scoreCandidate({ id: 'sentence', index: 0, text: input.text, startMs: 0, endMs: input.durationMs, durationMs: input.durationMs }, item); }

export interface ReadableDraftAdapter {
  readonly id: string;
  read(path: string): Promise<{ rootPath: string; payloads: Record<string, unknown>[] }>;
}

export class PlainJsonDraftAdapter implements ReadableDraftAdapter {
  readonly id = 'PLAIN_JSON';
  async read(path: string): Promise<{ rootPath: string; payloads: Record<string, unknown>[] }> {
    const absolutePath = resolve(path);
    const pathStat = await stat(absolutePath).catch(() => null);
    if (!pathStat) throw new Error('JIANYING_DRAFT_NOT_FOUND');
    const rootPath = pathStat.isDirectory() ? absolutePath : dirname(absolutePath);
    const payloads: Record<string, unknown>[] = [];
    if (pathStat.isDirectory()) {
      for (const fileName of ['draft_content.json', 'draft_info.json']) {
        const content = await readFile(join(absolutePath, fileName), 'utf8').catch(() => null);
        if (content) {
          try { payloads.push(JSON.parse(content) as Record<string, unknown>); } catch { throw new Error('JIANYING_DRAFT_INVALID_JSON'); }
        }
      }
      if (!payloads.length) throw new Error('JIANYING_DRAFT_CONTENT_NOT_FOUND');
    } else {
      try { payloads.push(JSON.parse(await readFile(absolutePath, 'utf8')) as Record<string, unknown>); } catch { throw new Error('JIANYING_DRAFT_INVALID_JSON'); }
    }
    return { rootPath, payloads };
  }
}

export class JianyingVideoEditorDllAdapter implements ReadableDraftAdapter {
  readonly id = 'JIANYING_VIDEOEDITOR_DLL';
  readonly status: 'AVAILABLE' | 'UNAVAILABLE';
  constructor(private readonly dllPath = process.env.JIANYING_VIDEOEDITOR_DLL) { this.status = dllPath ? 'AVAILABLE' : 'UNAVAILABLE'; }
  async read(_path: string): Promise<{ rootPath: string; payloads: Record<string, unknown>[] }> {
    if (this.status !== 'AVAILABLE') throw new Error('JIANYING_VIDEOEDITOR_DLL_UNAVAILABLE');
    throw new Error('JIANYING_VIDEOEDITOR_DLL_ADAPTER_NOT_IMPLEMENTED');
  }
}

export class JianyingDraftImporter {
  constructor(private readonly db: Pool, private readonly adapter: ReadableDraftAdapter = new PlainJsonDraftAdapter()) {}

  private async ensureLocalAsset(workspaceId: string, sourcePath: string): Promise<string> {
    const canonicalPath = resolve(sourcePath);
    const existing = (await this.db.query<{ file_id: string }>('select f.file_id from local_media_scan_files f join local_media_scans s on s.id=f.scan_id where s.workspace_id=$1 and lower(f.source_path)=lower($2) order by s.scanned_at desc nulls last limit 1', [workspaceId, canonicalPath])).rows[0];
    if (existing?.file_id) return existing.file_id;
    const details = await stat(canonicalPath).catch(() => null);
    const fileSize = details?.isFile() ? details.size : null;
    const modifiedAt = details?.isFile() ? details.mtime.toISOString() : null;
    let metadata: { durationMs: number; width: number; height: number; fps?: number; format: string; videoCodec?: string } = { durationMs: 0, width: 0, height: 0, format: basename(canonicalPath).split('.').pop() || 'unknown' };
    let available = false;
    let errorMessage: string | null = '剪映历史素材当前不可读';
    if (details?.isFile()) {
      try { metadata = await probeMedia(canonicalPath, process.env.FFPROBE_PATH || 'ffprobe'); available = metadata.durationMs > 0 && metadata.width > 0; errorMessage = available ? null : errorMessage; }
      catch (error) { errorMessage = error instanceof Error ? error.message.slice(0, 200) : errorMessage; }
    }
    const identity = `${canonicalPath.toLowerCase()}:${Number(fileSize || 0)}:${Number(metadata.durationMs || 0)}`;
    const fileId = `local-file-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
    const rootPath = dirname(canonicalPath);
    const rootId = `local-jianying-${createHash('sha256').update(rootPath.toLowerCase()).digest('hex').slice(0, 18)}`;
    const scanId = `jianying-media-scan-${createHash('sha256').update(`${workspaceId}:${canonicalPath.toLowerCase()}`).digest('hex').slice(0, 24)}`;
    const orientation = metadata.width > 0 && metadata.height > 0 ? metadata.width === metadata.height ? 'SQUARE' : metadata.height > metadata.width ? 'VERTICAL' : 'HORIZONTAL' : 'UNKNOWN';
    await this.db.query("insert into local_media_scans (id,workspace_id,source_root,source_root_id,recursive,status,scanned_at) values ($1,$2,$3,$4,false,'SUCCEEDED',now()) on conflict (id) do nothing", [scanId, workspaceId, rootPath, rootId]);
    await this.db.query("insert into local_media_scan_files (scan_id,file_id,file_name,relative_path,source_path,duration_ms,width,height,fps,format,codec,available,error_message,orientation,file_size,modified_at,tags,thumbnail_status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'[]','PENDING') on conflict (scan_id,file_id) do update set source_path=excluded.source_path,duration_ms=excluded.duration_ms,width=excluded.width,height=excluded.height,fps=excluded.fps,format=excluded.format,codec=excluded.codec,available=excluded.available,error_message=excluded.error_message,file_size=excluded.file_size,modified_at=excluded.modified_at", [scanId, fileId, basename(canonicalPath), basename(canonicalPath), canonicalPath, Math.max(0, Math.round(metadata.durationMs)), metadata.width, metadata.height, metadata.fps || null, metadata.format, metadata.videoCodec || null, available, errorMessage, orientation, fileSize, modifiedAt]);
    await this.db.query("insert into local_media_index (file_id,source_root_id,relative_path,file_name,duration_ms,width,height,fps,orientation,format,codec,file_size,modified_at,tags,availability,thumbnail_status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'[]',$14,'PENDING') on conflict (file_id) do update set source_root_id=excluded.source_root_id,relative_path=excluded.relative_path,file_name=excluded.file_name,duration_ms=excluded.duration_ms,width=excluded.width,height=excluded.height,fps=excluded.fps,orientation=excluded.orientation,format=excluded.format,codec=excluded.codec,file_size=excluded.file_size,modified_at=excluded.modified_at,availability=excluded.availability,updated_at=now()", [fileId, rootId, basename(canonicalPath), basename(canonicalPath), Math.max(0, Math.round(metadata.durationMs)), metadata.width, metadata.height, metadata.fps || null, orientation, metadata.format, metadata.videoCodec || null, fileSize, modifiedAt, available ? 'AVAILABLE' : 'MISSING']);
    return fileId;
  }

  async importReadOnly(workspaceId: string, draftPath: string): Promise<{ id: string; draftId: string; draftName: string; usageCount: number }> {
    const absolutePath = resolve(draftPath);
    const { rootPath, payloads } = await this.adapter.read(absolutePath);
    const parsed: Record<string, unknown> = Object.assign({}, ...payloads);
    const draftId = String(parsed.draft_id || parsed.draftId || basename(absolutePath));
    const draftName = String(parsed.draft_name || parsed.draftName || basename(rootPath));
    const previous = (await this.db.query<{ id: string }>('select id from jianying_draft_imports where workspace_id=$1 and draft_id=$2 and lower(draft_path)=lower($3) order by imported_at desc limit 1', [workspaceId, draftId, absolutePath])).rows[0];
    if (previous?.id) {
      const usageCount = Number((await this.db.query<{ count: string }>('select count(*)::text as count from jianying_asset_usages where draft_import_id=$1', [previous.id])).rows[0]?.count || 0);
      return { id: previous.id, draftId, draftName, usageCount };
    }
    const materialPaths = new Map<string, string>();
    const pathValue = (row: Record<string, unknown>): string | undefined => {
      const value = row.path || row.local_material_path || row.file_path || row.material_path;
      if (typeof value !== 'string' || !value.trim()) return undefined;
      const normalized = value.replace(/^file:\/\//u, '');
      // Jianying stores Windows drive paths even when the importer runs on Linux
      // (for example in CI). Treat those paths as absolute for resolution so the
      // same canonical path is used by the scanner and by the imported usage row.
      return isAbsolute(normalized) || /^[A-Za-z]:[\\/]/u.test(normalized) ? resolve(normalized) : resolve(rootPath, normalized);
    };
    const collectMaterials = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(collectMaterials); return; }
      if (!value || typeof value !== 'object') return;
      const row = value as Record<string, unknown>;
      const materialId = row.material_id || row.materialId || (row.type === 'video' ? row.id : undefined);
      const sourcePath = pathValue(row);
      if (materialId && sourcePath) materialPaths.set(String(materialId), sourcePath);
      Object.values(row).forEach(collectMaterials);
    };
    payloads.forEach(collectMaterials);
    const importId = `jianying-import-${randomUUID()}`;
    const usages: Array<{ assetId: string; materialId?: string; sourceInMs: number; sourceOutMs: number; timelineStartMs: number; timelineEndMs: number }> = [];
    const visit = (value: unknown, cursor = 0): void => {
      if (Array.isArray(value)) { value.forEach((item) => visit(item, cursor)); return; }
      if (!value || typeof value !== 'object') return;
      const row = value as Record<string, unknown>;
      const materialId = row.material_id || row.materialId;
      const source = row.source_timerange && typeof row.source_timerange === 'object' ? row.source_timerange as Record<string, unknown> : {};
      const target = row.target_timerange && typeof row.target_timerange === 'object' ? row.target_timerange as Record<string, unknown> : {};
      const toMs = (value: unknown, fallback = 0): number => { const numeric = Number(value ?? fallback); return numeric > 100_000 ? Math.round(numeric / 1_000) : Math.round(numeric); };
      const sourceInMs = toMs(source.start ?? source.start_time);
      const sourceDurationMs = toMs(source.duration ?? source.duration_time);
      const timelineStartMs = toMs(target.start ?? target.start_time, cursor);
      const timelineDurationMs = toMs(target.duration ?? target.duration_time, sourceDurationMs);
      const sourcePath = pathValue(row) || (materialId ? materialPaths.get(String(materialId)) : undefined);
      if (materialId && (sourcePath || row.material_id) && sourceDurationMs > 0) usages.push({ assetId: String(sourcePath || materialId), materialId: String(materialId), sourceInMs, sourceOutMs: sourceInMs + sourceDurationMs, timelineStartMs, timelineEndMs: timelineStartMs + timelineDurationMs });
      for (const [key, child] of Object.entries(row)) if (!['source_timerange', 'target_timerange'].includes(key)) visit(child, timelineStartMs + timelineDurationMs);
    };
    payloads.forEach((payload) => visit(payload));
    await this.db.query('insert into jianying_draft_imports (id, workspace_id, draft_id, draft_name, draft_path) values ($1,$2,$3,$4,$5)', [importId, workspaceId, draftId, draftName, absolutePath]);
    for (const usage of usages) {
      await this.db.query('insert into jianying_asset_usages (id,draft_import_id,asset_id,material_id,source_in_ms,source_out_ms,timeline_start_ms,timeline_end_ms) values ($1,$2,$3,$4,$5,$6,$7,$8)', [`jianying-usage-${randomUUID()}`, importId, usage.assetId, usage.materialId || null, usage.sourceInMs, usage.sourceOutMs, usage.timelineStartMs, usage.timelineEndMs]);
      const localAssetId = await this.ensureLocalAsset(workspaceId, usage.assetId);
      if (localAssetId) await this.db.query(`insert into script_editing_v3_asset_usage_stats (workspace_id,asset_id,jianying_use_count) values ($1,$2,1)
        on conflict (workspace_id,asset_id) do update set jianying_use_count=script_editing_v3_asset_usage_stats.jianying_use_count+1,updated_at=now()`, [workspaceId, localAssetId]);
    }
    return { id: importId, draftId, draftName, usageCount: usages.length };
  }
}

export class ScriptEditingV3Service {
  private readonly visualQueryProvider: VisualQueryProvider;
  private readonly semanticIndex: MaterialSemanticIndex;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly hybridMedia: HybridMediaService | undefined;
  private readonly storage: LocalStorageProvider | undefined;
  private readonly queryEmbeddingCache = new Map<string, number[]>();

  constructor(private readonly db: Pool, options: { visualQueryProvider?: VisualQueryProvider; semanticIndex?: MaterialSemanticIndex; embeddingProvider?: EmbeddingProvider; hybridMedia?: HybridMediaService; storage?: LocalStorageProvider } = {}) {
    this.visualQueryProvider = options.visualQueryProvider || createVisualQueryProvider();
    this.semanticIndex = options.semanticIndex || new InMemoryMaterialSemanticIndex();
    this.embeddingProvider = options.embeddingProvider || new QwenEmbeddingProvider();
    this.hybridMedia = options.hybridMedia;
    this.storage = options.storage;
  }

  private async incrementUsageStats(workspaceId: string, assetId: string, delta: { candidateCount?: number; selectedCount?: number; replaceCount?: number; manualSelectCount?: number }): Promise<void> {
    await this.db.query(`insert into script_editing_v3_asset_usage_stats (workspace_id,asset_id,candidate_count,selected_count,replace_count,manual_select_count)
      values ($1,$2,$3,$4,$5,$6)
      on conflict (workspace_id,asset_id) do update set candidate_count=script_editing_v3_asset_usage_stats.candidate_count+excluded.candidate_count,selected_count=script_editing_v3_asset_usage_stats.selected_count+excluded.selected_count,replace_count=script_editing_v3_asset_usage_stats.replace_count+excluded.replace_count,manual_select_count=script_editing_v3_asset_usage_stats.manual_select_count+excluded.manual_select_count,updated_at=now()`, [workspaceId, assetId, delta.candidateCount || 0, delta.selectedCount || 0, delta.replaceCount || 0, delta.manualSelectCount || 0]);
  }

  async setGold(snapshotId: string, assetId: string, gold: boolean): Promise<void> {
    const snapshot = await this.getSnapshot(snapshotId);
    if (!snapshot.items.some((item) => item.assetId === assetId)) throw new Error('MATERIAL_NOT_FOUND');
    await this.db.query(`insert into script_editing_v3_asset_usage_stats (workspace_id,asset_id,gold) values ($1,$2,$3)
      on conflict (workspace_id,asset_id) do update set gold=excluded.gold,updated_at=now()`, [snapshot.workspaceId, assetId, gold]);
  }

  async setDisabled(snapshotId: string, assetId: string, disabled: boolean): Promise<void> {
    const result = await this.db.query('update material_pool_items set disabled=$3 where snapshot_id=$1 and asset_id=$2 returning asset_id', [snapshotId, assetId, disabled]);
    if (!result.rowCount) throw new Error('MATERIAL_NOT_FOUND');
  }

  async persistVisualProfile(profile: AssetVisualProfileV3, sourceFingerprint?: string): Promise<void> {
    await this.db.query('insert into asset_visual_profiles (asset_id,summary,profile,provider,model_name,model_version,prompt_version,analysis_version,status,error,source_fingerprint) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,null,$10) on conflict (asset_id) do update set summary=excluded.summary,profile=excluded.profile,provider=excluded.provider,model_name=excluded.model_name,model_version=excluded.model_version,prompt_version=excluded.prompt_version,analysis_version=excluded.analysis_version,status=excluded.status,error=null,source_fingerprint=excluded.source_fingerprint,updated_at=now()', [profile.assetId, profile.summary, profile, profile.modelProvider, profile.modelName, profile.modelVersion, profile.promptVersion, profile.analysisVersion, 'READY', sourceFingerprint || null]);
    await this.db.query("delete from asset_tag_evidence where asset_id=$1 and evidence_kind='QWEN_VL'", [profile.assetId]);
    for (const tag of profile.tags) await this.db.query('insert into asset_tag_evidence (id,asset_id,tag,evidence_kind,confidence,timestamps_ms) values ($1,$2,$3,$4,$5,$6) on conflict (asset_id,tag,evidence_kind) do update set confidence=excluded.confidence,timestamps_ms=excluded.timestamps_ms', [`tag-evidence-${randomUUID()}`, profile.assetId, tag.tag, 'QWEN_VL', tag.confidence, JSON.stringify(tag.timestampsMs)]);
  }

  async persistSemanticEmbedding(input: { assetId: string; sourceFingerprint: string; provider: string; model: string; vector: number[] }): Promise<void> {
    if (!input.vector.length || input.vector.some((value) => !Number.isFinite(value))) throw new Error('SEMANTIC_EMBEDDING_INVALID');
    await this.db.query('insert into asset_semantic_embeddings (asset_id,source_fingerprint,provider,model_name,dimensions,vector) values ($1,$2,$3,$4,$5,$6) on conflict (asset_id) do update set source_fingerprint=excluded.source_fingerprint,provider=excluded.provider,model_name=excluded.model_name,dimensions=excluded.dimensions,vector=excluded.vector,updated_at=now()', [input.assetId, input.sourceFingerprint, input.provider, input.model, input.vector.length, JSON.stringify(input.vector)]);
  }

  async setManualTags(snapshotId: string, assetId: string, tags: string[]): Promise<string[]> {
    const snapshot = await this.getSnapshot(snapshotId);
    if (!snapshot.items.some((item) => item.assetId === assetId)) throw new Error('MATERIAL_NOT_FOUND');
    const normalized = normalizeControlledVisualTagsV3(tags);
    const client = await this.db.connect();
    try {
      await client.query('begin');
      await client.query("delete from asset_tag_evidence where asset_id=$1 and evidence_kind='MANUAL'", [assetId]);
      for (const tag of normalized) await client.query('insert into asset_tag_evidence (id,asset_id,tag,evidence_kind,confidence,timestamps_ms) values ($1,$2,$3,\'MANUAL\',$4,$5)', [`tag-evidence-${randomUUID()}`, assetId, tag, 1, '[]']);
      await client.query('commit');
      return normalized;
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async createMaterialPoolSnapshot(input: { workspaceId: string; sourceRootIds?: string[]; sourceFiles?: string[]; sourceKind?: 'MANUAL' | 'JIANYING_DRAFT' | 'MIXED' }): Promise<MaterialPoolSnapshotV3> {
    await ensureStandaloneWorkspace(this.db, input.workspaceId);
    const roots = input.sourceRootIds?.filter(Boolean) || [];
    // Keep the caller's path spelling in the snapshot. Native file pickers usually
    // provide absolute paths, while tests and API clients may provide relative
    // paths. Canonical paths are still used for stat/dedup/identity below.
    const sourceFiles = [...new Set((input.sourceFiles || []).filter(Boolean).map((path) => path.trim()))];
    const params: unknown[] = [input.workspaceId];
    const rootPlaceholder = roots.length ? `$${params.push(roots)}::text[]` : undefined;
    const rootClause = rootPlaceholder ? ` and s.source_root_id = any(${rootPlaceholder})` : '';
    const result = input.sourceKind === 'JIANYING_DRAFT' ? { rows: [] as PoolRow[] } : await this.db.query(`select distinct on (f.file_id) f.file_id, f.file_name, f.source_path, f.duration_ms, f.width, f.height, f.fps, f.codec, f.file_size, f.modified_at, f.available, f.error_message, coalesce(i.availability, case when f.available then 'AVAILABLE' else 'UNAVAILABLE' end) as index_availability, coalesce(i.tags, f.tags) as tags, i.thumbnail_key, i.usage_count, i.last_used_at, s.source_root_id from local_media_scan_files f join local_media_scans s on s.id=f.scan_id left join local_media_index i on i.file_id=f.file_id where s.workspace_id=$1 and s.status='SUCCEEDED'${rootClause} order by f.file_id, s.scanned_at desc nulls last`, params);
    const deduped = new Map<string, PoolRow>();
    for (const row of result.rows as PoolRow[]) {
      const canonical = resolve(String(row.source_path)).toLowerCase();
      const key = `${canonical}:${Number(row.file_size || 0)}:${Number(row.duration_ms)}`;
      if (!deduped.has(key)) deduped.set(key, { ...row, canonical_path: canonical, asset_id: String(row.file_id), source_fingerprint: materialSourceFingerprint({ fileSize: row.file_size == null ? null : Number(row.file_size), modifiedAt: row.modified_at == null ? null : String(row.modified_at), durationMs: Number(row.duration_ms) }), availability: row.index_availability === 'MISSING' ? 'MISSING' : row.available === false ? 'UNREADABLE' : 'VALID', error_message: row.error_message || null, source_ref: { sourceRootId: String(row.source_root_id), usageCount: Number(row.usage_count || 0), ...(row.last_used_at ? { lastUsedAt: new Date(String(row.last_used_at)).toISOString() } : {}) }, gold: false });
    }
    for (const sourcePath of sourceFiles) {
      const canonicalPath = resolve(sourcePath);
      const canonical = canonicalPath.toLowerCase();
      const details = await stat(canonicalPath).catch(() => null);
      const fileSize = details?.isFile() ? details.size : null;
      const modifiedAt = details?.isFile() ? details.mtime.toISOString() : null;
      const existing = (await this.db.query<{ file_id: string }>(`select f.file_id from local_media_scan_files f join local_media_scans s on s.id=f.scan_id where s.workspace_id=$1 and lower(f.source_path)=lower($2) and s.status='SUCCEEDED' order by s.scanned_at desc nulls last limit 1`, [input.workspaceId, canonicalPath])).rows[0];
      let metadata: { durationMs: number; width: number; height: number; fps?: number; format: string; videoCodec?: string };
      let availability: 'VALID' | 'UNREADABLE' = 'VALID';
      let errorMessage: string | null = null;
      try {
        if (!details?.isFile()) throw new Error('素材文件不存在');
        metadata = await probeMedia(canonicalPath, process.env.FFPROBE_PATH || 'ffprobe');
        if (metadata.durationMs <= 0 || metadata.width <= 0) throw new Error('无法读取视频元数据');
      } catch (error) {
        metadata = { durationMs: 0, width: 0, height: 0, format: 'unknown' };
        availability = 'UNREADABLE';
        errorMessage = error instanceof Error ? error.message.slice(0, 200) : '无法读取视频元数据';
      }
      const key = `${canonical}:${Number(fileSize || 0)}:${Number(metadata.durationMs)}`;
      if (!deduped.has(key)) deduped.set(key, { canonical_path: canonical, asset_id: existing?.file_id || `local-file-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`, source_path: sourcePath, file_name: basename(sourcePath), duration_ms: metadata.durationMs, width: metadata.width, height: metadata.height, fps: metadata.fps, format: metadata.format, codec: metadata.videoCodec || null, file_size: fileSize, modified_at: modifiedAt, source_fingerprint: materialSourceFingerprint({ fileSize, modifiedAt, durationMs: metadata.durationMs }), tags: [], availability, error_message: errorMessage, source_ref: { sourceFile: true }, gold: false });
    }
    if (roots.length) {
      const missingRows = await this.db.query(`select distinct on (i.file_id) i.file_id,i.file_name,f.source_path,i.duration_ms,i.width,i.height,i.fps,i.codec,i.file_size,i.modified_at,i.tags,i.thumbnail_key,i.usage_count,i.last_used_at,i.source_root_id from local_media_index i join local_media_scan_files f on f.file_id=i.file_id join local_media_scans s on s.id=f.scan_id where s.workspace_id=$1 and i.source_root_id=any($2::text[]) and i.availability='MISSING' order by i.file_id,s.scanned_at desc nulls last`, [input.workspaceId, roots]);
      for (const row of missingRows.rows as PoolRow[]) {
        const canonical = resolve(String(row.source_path)).toLowerCase();
        const key = `${canonical}:${Number(row.file_size || 0)}:${Number(row.duration_ms)}`;
        if (!deduped.has(key)) deduped.set(key, { ...row, canonical_path: canonical, asset_id: String(row.file_id), source_fingerprint: materialSourceFingerprint({ fileSize: row.file_size == null ? null : Number(row.file_size), modifiedAt: row.modified_at == null ? null : String(row.modified_at), durationMs: Number(row.duration_ms) }), availability: 'MISSING', error_message: '素材在最近一次扫描中不存在', source_ref: { sourceRootId: String(row.source_root_id), usageCount: Number(row.usage_count || 0), ...(row.last_used_at ? { lastUsedAt: new Date(String(row.last_used_at)).toISOString() } : {}) }, gold: false });
      }
    }
    if (input.sourceKind === 'JIANYING_DRAFT' || input.sourceKind === 'MIXED') {
      const draftRows = await this.db.query(`select distinct on (f.file_id) f.file_id,f.file_name,f.source_path,f.duration_ms,f.width,f.height,f.fps,f.codec,f.file_size,f.modified_at,f.available,f.error_message,coalesce(i.availability,case when f.available then 'VALID' else 'MISSING' end) as index_availability,coalesce(i.tags,f.tags) as tags,i.thumbnail_key,i.usage_count,i.last_used_at,s.source_root_id,count(*) over (partition by f.file_id)::int as jianying_usage_count,d.draft_id,d.draft_name
        from jianying_asset_usages u join jianying_draft_imports d on d.id=u.draft_import_id join local_media_scan_files f on lower(f.source_path)=lower(u.asset_id) join local_media_scans s on s.id=f.scan_id left join local_media_index i on i.file_id=f.file_id
        where d.workspace_id=$1 and d.status='IMPORTED' and s.status='SUCCEEDED' order by f.file_id,d.imported_at desc nulls last,s.scanned_at desc nulls last`, [input.workspaceId]);
      for (const row of draftRows.rows as PoolRow[]) {
        const canonical = resolve(String(row.source_path)).toLowerCase();
        const key = `${canonical}:${Number(row.file_size || 0)}:${Number(row.duration_ms)}`;
      if (!deduped.has(key)) deduped.set(key, { ...row, canonical_path: canonical, asset_id: String(row.file_id), source_fingerprint: materialSourceFingerprint({ fileSize: row.file_size == null ? null : Number(row.file_size), modifiedAt: row.modified_at == null ? null : String(row.modified_at), durationMs: Number(row.duration_ms) }), availability: row.index_availability === 'MISSING' || row.available === false ? 'MISSING' : 'VALID', error_message: row.error_message || null, source_ref: { sourceRootId: String(row.source_root_id), usageCount: Number(row.usage_count || 0), jianyingUseCount: Number(row.jianying_usage_count || 0), draftId: String(row.draft_id), draftName: String(row.draft_name), ...(row.last_used_at ? { lastUsedAt: new Date(String(row.last_used_at)).toISOString() } : {}) }, gold: false });
      }
    }
    if (!deduped.size) throw new Error('MATERIAL_POOL_EMPTY');
    const nextRevision = Number((await this.db.query<{ revision: number }>('select coalesce(max(revision),0)+1 as revision from material_pool_snapshots where workspace_id=$1', [input.workspaceId])).rows[0]?.revision || 1);
    const snapshotId = `material-pool-snapshot-${randomUUID()}`;
    await this.db.query('insert into material_pool_snapshots (id,workspace_id,revision,source_spec) values ($1,$2,$3,$4)', [snapshotId, input.workspaceId, nextRevision, { sourceKind: input.sourceKind || 'MANUAL', sourceRootIds: roots, sourceFiles }]);
    for (const row of deduped.values()) {
      const tags = normalizeControlledVisualTagsV3(Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : []);
      const rowSourceKind = row.source_ref && typeof row.source_ref === 'object' && (row.source_ref as Record<string, unknown>).draftId ? 'JIANYING_DRAFT' : 'MANUAL';
      await this.db.query('insert into material_pool_items (snapshot_id,asset_id,canonical_path,source_path,file_name,duration_ms,width,height,fps,codec,file_size,modified_at,source_fingerprint,tags,source_kind,source_ref,thumbnail_key,gold,availability,error_message) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)', [snapshotId, String(row.asset_id), String(row.canonical_path), String(row.source_path), String(row.file_name), Math.max(0, Number(row.duration_ms)), Number(row.width || 0), Number(row.height || 0), row.fps == null ? null : Number(row.fps), row.codec || null, row.file_size == null ? null : Number(row.file_size), row.modified_at || null, String(row.source_fingerprint || materialSourceFingerprint({ fileSize: row.file_size == null ? null : Number(row.file_size), modifiedAt: row.modified_at == null ? null : String(row.modified_at), durationMs: Number(row.duration_ms) })), JSON.stringify(tags), rowSourceKind, row.source_ref || {}, row.thumbnail_key || null, Boolean(row.gold), row.availability || 'VALID', row.error_message || null]);
      for (const tag of tags) await this.db.query('insert into asset_tag_evidence (id,asset_id,tag,evidence_kind,confidence,timestamps_ms) values ($1,$2,$3,$4,$5,$6) on conflict (asset_id,tag,evidence_kind) do update set confidence=excluded.confidence', [`tag-evidence-${randomUUID()}`, String(row.asset_id), tag, rowSourceKind === 'JIANYING_DRAFT' ? 'JIANYING_HISTORY' : 'FOLDER', 0.5, '[]']);
    }
    return this.getSnapshot(snapshotId);
  }

  async getSnapshot(snapshotId: string): Promise<MaterialPoolSnapshotV3> {
    const header = (await this.db.query('select * from material_pool_snapshots where id=$1', [snapshotId])).rows[0] as PoolRow | undefined;
    if (!header) throw new Error('MATERIAL_POOL_SNAPSHOT_NOT_FOUND');
    const rows = await this.db.query("select i.*,p.status as ai_status,p.profile as ai_profile,u.jianying_use_count,u.candidate_count,u.selected_count,u.final_use_count,u.content_os_final_use_count,u.replace_count,u.manual_select_count,u.recent_use_count,u.gold as stats_gold,u.last_used_at as stats_last_used_at,coalesce(mt.manual_tags,'[]'::jsonb) as manual_tags from material_pool_items i left join asset_visual_profiles p on p.asset_id=i.asset_id and p.source_fingerprint=i.source_fingerprint left join script_editing_v3_asset_usage_stats u on u.workspace_id=$2 and u.asset_id=i.asset_id left join lateral (select jsonb_agg(e.tag order by e.tag) as manual_tags from asset_tag_evidence e where e.asset_id=i.asset_id and e.evidence_kind='MANUAL') mt on true where i.snapshot_id=$1 order by i.file_name,i.asset_id", [snapshotId, header.workspace_id]);
    return { id: String(header.id), workspaceId: String(header.workspace_id), revision: Number(header.revision), items: (rows.rows as PoolRow[]).map(mapPoolItem), createdAt: new Date(String(header.created_at)).toISOString() };
  }

  async getMaterialPoolHealth(snapshotId: string): Promise<MaterialPoolHealthV3> {
    const header = (await this.db.query('select id,workspace_id,source_spec from material_pool_snapshots where id=$1', [snapshotId])).rows[0] as PoolRow | undefined;
    if (!header) throw new Error('MATERIAL_POOL_SNAPSHOT_NOT_FOUND');
    const snapshot = await this.getSnapshot(snapshotId);
    const profiles = await this.db.query<{ asset_id: string; status: string }>('select p.asset_id,p.status from asset_visual_profiles p join material_pool_items i on i.asset_id=p.asset_id and i.source_fingerprint=p.source_fingerprint where i.snapshot_id=$1', [snapshotId]);
    const aiStatus = new Map(profiles.rows.map((row) => [row.asset_id, row.status]));
    let valid = 0;
    let missing = 0;
    let unreadable = 0;
    let duplicate = 0;
    for (const item of snapshot.items) {
      const details = await stat(item.sourcePath).catch(() => null);
      if (item.availability === 'MISSING' || !details?.isFile()) missing += 1;
      else if (item.availability === 'UNREADABLE' || item.durationMs <= 0) unreadable += 1;
      else if (item.availability === 'DUPLICATE') duplicate += 1;
      else valid += 1;
    }
    const sourceSpec = header.source_spec && typeof header.source_spec === 'object' ? header.source_spec as Record<string, unknown> : {};
    const rootIds = Array.isArray(sourceSpec.sourceRootIds) ? sourceSpec.sourceRootIds.filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
    if (rootIds.length) {
      const duplicateRows = await this.db.query<{ duplicate_count: number }>(`with latest as (select distinct on (f.file_id) f.source_path,f.file_size,f.duration_ms from local_media_scan_files f join local_media_scans s on s.id=f.scan_id where s.workspace_id=$1 and s.status='SUCCEEDED' and s.source_root_id=any($2::text[]) order by f.file_id,s.scanned_at desc nulls last) select coalesce(sum(group_count - 1), 0)::int as duplicate_count from (select lower(source_path),coalesce(file_size,0),duration_ms,count(*)::int as group_count from latest group by lower(source_path),coalesce(file_size,0),duration_ms having count(*) > 1) duplicates`, [String(header.workspace_id), rootIds]);
      duplicate = Number(duplicateRows.rows[0]?.duplicate_count || 0);
      const unavailableRows = await this.db.query<{ unavailable: number; missing: number }>(`with latest as (select distinct on (f.file_id) f.available,i.availability from local_media_scan_files f join local_media_scans s on s.id=f.scan_id left join local_media_index i on i.file_id=f.file_id where s.workspace_id=$1 and s.status='SUCCEEDED' and s.source_root_id=any($2::text[]) order by f.file_id,s.scanned_at desc nulls last) select count(*) filter (where not available)::int as unavailable, count(*) filter (where availability='MISSING')::int as missing from latest`, [String(header.workspace_id), rootIds]);
      unreadable = Math.max(unreadable, Number(unavailableRows.rows[0]?.unavailable || 0));
      missing = Math.max(missing, Number(unavailableRows.rows[0]?.missing || 0));
    }
    let aiPending = 0;
    let aiReady = 0;
    let aiFailed = 0;
    let aiNotRequested = 0;
    for (const item of snapshot.items) {
      const status = aiStatus.get(item.assetId);
      if (status === 'PENDING') aiPending += 1;
      else if (status === 'READY') aiReady += 1;
      else if (status === 'FAILED') aiFailed += 1;
      else aiNotRequested += 1;
    }
    return { total: snapshot.items.length, valid, missing, unreadable, duplicate, aiPending, aiReady, aiFailed, aiNotRequested };
  }

  async createSession(input: { workspaceId: string; snapshotId: string; script: string; voicePath?: string | undefined; settings?: SessionSettingsV3 | undefined; sentences?: Array<{ text: string; startMs?: number | undefined; endMs?: number | undefined; voiceStartMs?: number | undefined; voiceEndMs?: number | undefined; durationMs?: number | undefined }> | undefined }): Promise<{ id: string; status: string; revision: number }> {
    await ensureStandaloneWorkspace(this.db, input.workspaceId);
    if (input.sentences?.length && comparableScript(input.script) !== comparableScript(input.sentences.map((row) => row.text).join(''))) throw new Error('SCRIPT_SEGMENTATION_STALE');
    let cursor = 0;
    const sentences = input.sentences?.length ? input.sentences.map((row, index) => {
      const explicitStart = row.startMs ?? row.voiceStartMs;
      const startMs = explicitStart === undefined ? cursor : Number(explicitStart);
      const explicitEnd = row.endMs ?? row.voiceEndMs;
      const durationMs = Number(row.durationMs ?? (explicitEnd === undefined ? 3_000 : Number(explicitEnd) - startMs));
      const endMs = explicitEnd === undefined ? startMs + durationMs : Number(explicitEnd);
      cursor = Math.max(cursor, endMs);
      return { id: `sentence-${index}`, index, text: row.text.trim(), startMs, endMs, durationMs: Number(row.durationMs ?? (endMs - startMs)) };
    }) : segmentScriptSentences(input.script).map((row, index) => ({ id: `sentence-${index}`, index, text: row.text, startMs: index * 3_000, endMs: (index + 1) * 3_000, durationMs: 3_000 }));
    if (!sentences.length) throw new Error('SCRIPT_SEGMENTATION_EMPTY');
    const snapshot = await this.getSnapshot(input.snapshotId);
    if (snapshot.workspaceId !== input.workspaceId) throw new Error('MATERIAL_POOL_SCOPE_MISMATCH');
    const id = `script-editing-v3-${randomUUID()}`;
    await this.db.query('insert into script_editing_v3_sessions (id,workspace_id,material_pool_snapshot_id,script,voice_path,settings,sentences) values ($1,$2,$3,$4,$5,$6,$7)', [id, input.workspaceId, input.snapshotId, input.script, input.voicePath || null, JSON.stringify(input.settings || {}), JSON.stringify(sentences)]);
    const generatedBySentence = new Map<string, { queries: string[]; model: string; promptVersion: string }>();
    const batches = Array.from({ length: Math.ceil(sentences.length / 16) }, (_, index) => sentences.slice(index * 16, index * 16 + 16));
    for (const batch of batches) {
      try {
        const generated = this.visualQueryProvider.generateQueriesBatch ? await this.visualQueryProvider.generateQueriesBatch({ sentences: batch.map((sentence) => ({ sentenceId: sentence.id, text: sentence.text })) }) : await Promise.all(batch.map(async (sentence) => ({ sentenceId: sentence.id, ...(await this.visualQueryProvider.generateQueries({ sentenceId: sentence.id, text: sentence.text })) })));
        for (const item of generated) generatedBySentence.set(item.sentenceId, item);
      } catch { /* fall through to deterministic per-sentence rules below */ }
    }
    for (const sentence of sentences) {
      const generated = generatedBySentence.get(sentence.id) || await new RuleVisualQueryProvider().generateQueries({ sentenceId: sentence.id, text: sentence.text });
      for (const query of generated.queries) await this.db.query('insert into visual_queries (id,session_id,sentence_id,query,model,prompt_version) values ($1,$2,$3,$4,$5,$6)', [`visual-query-${randomUUID()}`, id, sentence.id, query, generated.model, generated.promptVersion]);
    }
    await this.rankCandidates(id, snapshot, sentences);
    return { id, status: 'DRAFT', revision: 1 };
  }

  private async rankCandidates(sessionId: string, snapshot: MaterialPoolSnapshotV3, sentences: SentenceV3[]): Promise<void> {
    const profileRows = await this.db.query<{ asset_id: string; source_fingerprint: string | null; profile: AssetVisualProfileV3 }>('select asset_id,source_fingerprint,profile from asset_visual_profiles where asset_id = any($1::text[]) and status=\'READY\'', [snapshot.items.map((item) => item.assetId)]);
    const fingerprints = new Map(snapshot.items.map((item) => [item.assetId, item.sourceFingerprint]));
    const profiles = new Map(profileRows.rows.filter((row) => fingerprints.get(row.asset_id) && fingerprints.get(row.asset_id) === row.source_fingerprint).map((row) => [row.asset_id, row.profile]));
    const queryRows = await this.db.query<{ sentence_id: string; query: string }>('select sentence_id,query from visual_queries where session_id=$1 order by created_at,id', [sessionId]);
    const queriesBySentence = new Map<string, string[]>();
    for (const row of queryRows.rows) queriesBySentence.set(row.sentence_id, [...(queriesBySentence.get(row.sentence_id) || []), row.query]);
    await this.semanticScores(snapshot, profiles, [...new Set(queryRows.rows.map((row) => row.query))]);
    for (const sentence of sentences) {
      const queries = queriesBySentence.get(sentence.id) || buildQueries(sentence);
      const semanticHits = new Map((await this.semanticScores(snapshot, profiles, queries)).map((hit) => [hit.assetId, hit.score]));
      const ranked = snapshot.items.filter((item) => item.durationMs >= sentence.durationMs && item.availability === 'VALID' && !item.disabled).map((item) => ({ ...scoreCandidate(sentence, item, profiles.get(item.assetId), queries, semanticHits.get(item.assetId)), sourceSegmentId: `segment-${sessionId}-${sentence.id}-${item.assetId}` })).sort((a, b) => b.finalScore - a.finalScore || a.assetId.localeCompare(b.assetId)).slice(0, 5);
      for (const ranking of ranked) {
        const inserted = await this.db.query('insert into candidate_rankings (id,session_id,sentence_id,asset_id,ranking) values ($1,$2,$3,$4,$5) on conflict (session_id,sentence_id,asset_id) do update set ranking=excluded.ranking,created_at=now() returning (xmax = 0) as inserted', [`candidate-${randomUUID()}`, sessionId, sentence.id, ranking.assetId, ranking]);
        if (inserted.rows[0]?.inserted) await this.incrementUsageStats(snapshot.workspaceId, ranking.assetId, { candidateCount: 1 });
      }
    }
  }

  private async semanticScores(snapshot: MaterialPoolSnapshotV3, profiles: Map<string, AssetVisualProfileV3>, queries: string[]): Promise<Array<{ assetId: string; score: number }>> {
    const embeddingRows = await this.db.query<{ asset_id: string; source_fingerprint: string; vector: unknown }>('select asset_id,source_fingerprint,vector from asset_semantic_embeddings where asset_id = any($1::text[])', [snapshot.items.map((item) => item.assetId)]);
    const fingerprints = new Map(snapshot.items.map((item) => [item.assetId, item.sourceFingerprint]));
    const embeddings = new Map<string, number[]>();
    for (const row of embeddingRows.rows) {
      const vector = typeof row.vector === 'string' ? JSON.parse(row.vector) : row.vector;
      if (fingerprints.get(row.asset_id) && fingerprints.get(row.asset_id) === row.source_fingerprint && Array.isArray(vector) && vector.length && vector.every((value) => typeof value === 'number' && Number.isFinite(value))) embeddings.set(row.asset_id, vector as number[]);
    }
    await this.semanticIndex.build({ snapshotId: snapshot.id, items: snapshot.items, profiles, embeddings });
    let queryVectors: number[][] | undefined;
    try {
      if (embeddings.size) {
        const uniqueQueries = [...new Set(queries)];
        const missing = uniqueQueries.filter((query) => !this.queryEmbeddingCache.has(query));
        if (missing.length) {
          const generated = await this.embeddingProvider.embed({ texts: missing });
          generated.vectors.forEach((vector, index) => { if (vector?.length && vector.every((value) => Number.isFinite(value))) this.queryEmbeddingCache.set(missing[index]!, vector); });
        }
        const vectors = queries.map((query) => this.queryEmbeddingCache.get(query));
        if (vectors.every((vector): vector is number[] => Boolean(vector))) queryVectors = vectors;
      }
    } catch { queryVectors = undefined; }
    return this.semanticIndex.search({ snapshotId: snapshot.id, queries, ...(queryVectors ? { queryVectors } : {}), limit: snapshot.items.length });
  }

  private async addImportedAssetItems(workspaceId: string, assetIds: string[], itemById: Map<string, MaterialPoolItemV3>): Promise<void> {
    if (!this.storage || !assetIds.length) return;
    const rows = await this.db.query<{ id: string; storage_key: string; metadata: Record<string, unknown> | null }>('select a.id,a.storage_key,a.metadata from assets a join video_workspace_assets wa on wa.asset_id=a.id and wa.workspace_id=$1 and wa.role=\'SOURCE\' where a.id=any($2::text[]) and a.lifecycle=\'READY\'', [workspaceId, assetIds]);
    for (const row of rows.rows) {
      const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      const durationMs = Number(metadata.durationMs || 0);
      if (!Number.isFinite(durationMs) || durationMs <= 0) continue;
      const external = metadata.external && typeof metadata.external === 'object' ? metadata.external as Record<string, unknown> : {};
      itemById.set(row.id, { assetId: row.id, sourcePath: this.storage.objectPath(row.storage_key), fileName: typeof metadata.originalName === 'string' ? metadata.originalName : basename(row.storage_key), durationMs, width: Number(metadata.width || external.originalWidth || 0), height: Number(metadata.height || external.originalHeight || 0), tags: [], availability: 'VALID' });
    }
  }

  async getSession(sessionId: string): Promise<{ id: string; workspaceId: string; snapshotId: string; script: string; revision: number; status: string; manifestId?: string; cards: SentenceEditingCardV3[] }> {
    const row = (await this.db.query('select * from script_editing_v3_sessions where id=$1', [sessionId])).rows[0] as PoolRow | undefined;
    if (!row) throw new Error('SCRIPT_EDITING_V3_SESSION_NOT_FOUND');
    const snapshot = await this.getSnapshot(String(row.material_pool_snapshot_id));
    const itemById = new Map(snapshot.items.map((item) => [item.assetId, item]));
    const manifest = row.current_manifest_id ? (await this.db.query('select manifest from edit_manifests where id=$1', [row.current_manifest_id])).rows[0]?.manifest as EditManifestV0 | undefined : undefined;
    const rankings = await this.db.query('select sentence_id,ranking from candidate_rankings where session_id=$1 order by created_at desc', [sessionId]);
    const ranked = new Map<string, CandidateV3[]>();
    for (const candidate of rankings.rows as Array<{ sentence_id: string; ranking: CandidateV3 }>) { const current = ranked.get(candidate.sentence_id) || []; if (!current.some((item) => item.assetId === candidate.ranking.assetId)) current.push(candidate.ranking); ranked.set(candidate.sentence_id, current); }
    const clips = new Map((manifest?.timeline || []).map((clip) => [clip.sentenceId || `sentence-${clip.sentenceIndex}`, clip]));
    await this.addImportedAssetItems(String(row.workspace_id), [...new Set((manifest?.timeline || []).map((clip) => clip.assetId).filter((assetId) => !itemById.has(assetId)))], itemById);
    const sentences = sentenceRows(row.sentences);
    for (const candidates of ranked.values()) candidates.sort((left, right) => right.finalScore - left.finalScore || left.assetId.localeCompare(right.assetId));
    const cards = sentences.map((sentence) => {
      const clip = clips.get(sentence.id);
      const cardClip: ClipInstanceV3 | null = clip ? { id: `clip-${sessionId}-${sentence.id}`, sentenceId: sentence.id, ...(clip.sourceSegmentId ? { sourceSegmentId: clip.sourceSegmentId } : {}), assetId: clip.assetId, sourceInMs: clip.sourceInMs, sourceOutMs: clip.sourceOutMs ?? clip.sourceInMs + clip.durationMs, timelineStartMs: clip.timelineStartMs ?? sentence.startMs, durationMs: clip.durationMs, locked: Boolean(clip.locked), selectionSource: clip.selectionSource || 'AUTO', reviewStatus: clip.reviewStatus === 'MANUAL' ? 'REVIEWED' : 'UNREVIEWED', revision: Number(clip.revision || row.revision) } : null;
      const asset = clip ? itemById.get(clip.assetId) : undefined;
      return { sentenceId: sentence.id, index: sentence.index, text: sentence.text, startMs: sentence.startMs, endMs: sentence.endMs, clip: cardClip, ...(asset ? { asset } : {}), candidates: ranked.get(sentence.id) || [] };
    });
    return { id: String(row.id), workspaceId: String(row.workspace_id), snapshotId: String(row.material_pool_snapshot_id), script: String(row.script), revision: Number(row.revision), status: String(row.status), ...(row.current_manifest_id ? { manifestId: String(row.current_manifest_id) } : {}), cards };
  }

  private async currentManifest(sessionId: string): Promise<{ session: PoolRow; manifest: EditManifestV0 }> {
    const session = (await this.db.query('select * from script_editing_v3_sessions where id=$1', [sessionId])).rows[0] as PoolRow | undefined;
    if (!session?.current_manifest_id) throw new Error('SCRIPT_EDITING_V3_MANIFEST_NOT_READY');
    const manifest = (await this.db.query('select manifest from edit_manifests where id=$1', [session.current_manifest_id])).rows[0]?.manifest as EditManifestV0 | undefined;
    if (!manifest) throw new Error('SCRIPT_EDITING_V3_MANIFEST_NOT_FOUND');
    return { session, manifest };
  }

  async generate(sessionId: string): Promise<{ manifestId: string; revision: number }> {
    const sessionRow = (await this.db.query('select * from script_editing_v3_sessions where id=$1', [sessionId])).rows[0] as PoolRow | undefined;
    if (!sessionRow) throw new Error('SCRIPT_EDITING_V3_SESSION_NOT_FOUND');
    const snapshot = await this.getSnapshot(String(sessionRow.material_pool_snapshot_id));
    const sentences = sentenceRows(sessionRow.sentences);
    const editorialSentences: TimedScriptSentence[] = sentences.map((sentence) => ({ index: sentence.index, text: sentence.text, normalizedText: sentence.text.normalize('NFKC').toLowerCase(), voiceStartMs: sentence.startMs, voiceEndMs: sentence.endMs, durationMs: sentence.durationMs }));
    const settings = sessionRow.settings && typeof sessionRow.settings === 'object' ? sessionRow.settings as SessionSettingsV3 : {};
    const templateValues = new Set<EditorialTemplateV1>(['COMMERCIAL_OPINION', 'NEWS', 'STORE_PROMOTION', 'PRODUCT_INTRO']);
    const paceValues = new Set<EditorialPaceV1>(['SLOW', 'NORMAL', 'FAST']);
    const densityValues = new Set<EditorialShotDensityV1>(['LOW', 'MEDIUM', 'HIGH']);
    const template = typeof settings.template === 'string' && templateValues.has(settings.template as EditorialTemplateV1) ? settings.template as EditorialTemplateV1 : 'COMMERCIAL_OPINION';
    const pace = typeof settings.pace === 'string' && paceValues.has(settings.pace as EditorialPaceV1) ? settings.pace as EditorialPaceV1 : undefined;
    const shotDensity = typeof settings.shotDensity === 'string' && densityValues.has(settings.shotDensity as EditorialShotDensityV1) ? settings.shotDensity as EditorialShotDensityV1 : undefined;
    const subtitleStyle = typeof settings.subtitleStyle === 'string' && ['simple', 'commercial', 'emphasis', 'news'].includes(settings.subtitleStyle) ? settings.subtitleStyle as 'simple' | 'commercial' | 'emphasis' | 'news' : undefined;
    const presentationSettings = normalizePresentationSettings(settings.presentationSettings as Partial<PresentationSettingsV1> | undefined);
    const rawAudio = settings.audioPlan && typeof settings.audioPlan === 'object' ? settings.audioPlan as Record<string, unknown> : undefined;
    const audioPlan: Partial<EditorialAudioPlanV1> | undefined = rawAudio ? {
      backgroundMusicMode: rawAudio.backgroundMusicMode === 'SPECIFIED' ? 'SPECIFIED' : rawAudio.backgroundMusicMode === 'AUTO' ? 'AUTO' : 'NONE',
      ...(typeof rawAudio.category === 'string' && rawAudio.category.trim() ? { category: rawAudio.category } : {}),
      ...(typeof rawAudio.path === 'string' && rawAudio.path.trim() ? { path: rawAudio.path } : {}),
      ...(typeof rawAudio.volume === 'number' && Number.isFinite(rawAudio.volume) ? { volume: Math.min(1, Math.max(0, rawAudio.volume)) } : {}),
      ...(typeof rawAudio.duckingEnabled === 'boolean' ? { duckingEnabled: rawAudio.duckingEnabled } : {}),
    } : undefined;
    const rawBranding = settings.brandingPlan && typeof settings.brandingPlan === 'object' ? settings.brandingPlan as Record<string, unknown> : undefined;
    const usePexels = settings.usePexels === true;
    const brandingPlan: Partial<EditorialBrandingPlanV1> | undefined = rawBranding ? {
      introEnabled: rawBranding.introEnabled === true,
      outroEnabled: rawBranding.outroEnabled === true,
      ...(typeof rawBranding.brandingPresetId === 'string' && rawBranding.brandingPresetId.trim() ? { brandingPresetId: rawBranding.brandingPresetId } : {}),
    } : undefined;
    const editorialPlan = planEditorialScript({ sentences: editorialSentences, template, ...(pace ? { pace } : {}), ...(shotDensity ? { shotDensity } : {}), ...(subtitleStyle ? { subtitleStyle } : {}), oneClipPerSegment: true, presentationSettings, ...(audioPlan ? { audioPlan } : {}), ...(brandingPlan ? { brandingPlan } : {}) });
    const sceneBySentence = new Map(editorialPlan.scenes.map((scene) => [scene.sentenceIndex, scene]));
    await this.rankCandidates(sessionId, snapshot, sentences);
    const previousManifest = sessionRow.current_manifest_id ? (await this.db.query('select manifest from edit_manifests where id=$1', [sessionRow.current_manifest_id])).rows[0]?.manifest as EditManifestV0 | undefined : undefined;
    const previousBySentence = new Map((previousManifest?.timeline || []).filter((clip) => Boolean(clip.sentenceId)).map((clip) => [clip.sentenceId!, clip]));
    const profileRows = await this.db.query<{ asset_id: string; source_fingerprint: string | null; profile: AssetVisualProfileV3 }>('select asset_id,source_fingerprint,profile from asset_visual_profiles where asset_id = any($1::text[]) and status=\'READY\'', [snapshot.items.map((item) => item.assetId)]);
    const fingerprints = new Map(snapshot.items.map((item) => [item.assetId, item.sourceFingerprint]));
    const profiles = new Map(profileRows.rows.filter((row) => fingerprints.get(row.asset_id) && fingerprints.get(row.asset_id) === row.source_fingerprint).map((row) => [row.asset_id, row.profile]));
    const queryRows = await this.db.query<{ sentence_id: string; query: string }>('select sentence_id,query from visual_queries where session_id=$1 order by created_at,id', [sessionId]);
    const queriesBySentence = new Map<string, string[]>();
    for (const row of queryRows.rows) queriesBySentence.set(row.sentence_id, [...(queriesBySentence.get(row.sentence_id) || []), row.query]);
    await this.semanticScores(snapshot, profiles, [...new Set(queryRows.rows.map((row) => row.query))]);
    let cursor = 0;
    const timeline: ManifestClip[] = [];
    for (const sentence of sentences) {
      const locked = previousBySentence.get(sentence.id);
      const timelineStartMs = Math.max(cursor, sentence.startMs);
      if (locked?.locked) { timeline.push({ ...locked, timelineStartMs: locked.timelineStartMs ?? timelineStartMs, timelineEndMs: locked.timelineEndMs ?? (timelineStartMs + locked.durationMs) }); cursor = Math.max(timelineStartMs + locked.durationMs, Number(locked.timelineEndMs || 0)); continue; }
      const queries = queriesBySentence.get(sentence.id) || buildQueries(sentence);
      const semanticHits = new Map((await this.semanticScores(snapshot, profiles, queries)).map((hit) => [hit.assetId, hit.score]));
      const eligible = snapshot.items.filter((item) => item.durationMs >= sentence.durationMs && item.availability === 'VALID' && !item.disabled);
      const previousAssetId = timeline.at(-1)?.assetId;
      const distinctEligible = eligible.filter((item) => item.assetId !== previousAssetId);
      const candidate = (distinctEligible.length ? distinctEligible : eligible).map((item) => ({ ...scoreCandidate(sentence, item, profiles.get(item.assetId), queries, semanticHits.get(item.assetId)), sourceSegmentId: `segment-${sessionId}-${sentence.id}-${item.assetId}` })).sort((a, b) => b.finalScore - a.finalScore || a.assetId.localeCompare(b.assetId))[0];
      let selectedAsset: PlannerAsset | undefined = candidate ? {
        id: candidate.assetId,
        storageKey: candidate.assetId,
        sourcePath: snapshot.items.find((item) => item.assetId === candidate.assetId)!.sourcePath,
        durationMs: snapshot.items.find((item) => item.assetId === candidate.assetId)!.durationMs,
        originalName: snapshot.items.find((item) => item.assetId === candidate.assetId)!.fileName,
        tags: snapshot.items.find((item) => item.assetId === candidate.assetId)!.tags,
      } : undefined;
      let selectedSource: 'LOCAL' | 'PEXELS' | 'FAKE_PEXELS' = 'LOCAL';
      let selectedSourceReason = sceneBySentence.get(sentence.index)?.reason || 'V3 candidate ranking';
      if (!selectedAsset && usePexels && this.hybridMedia) {
        const localAssets: PlannerAsset[] = snapshot.items.filter((item) => item.availability === 'VALID' && !item.disabled).map((item) => ({ id: item.assetId, storageKey: item.assetId, sourcePath: item.sourcePath, durationMs: item.durationMs, originalName: item.fileName, tags: [...item.tags, ...(item.aiTags || [])] }));
        const hybridResult = await this.hybridMedia.resolve({ workspaceId: String(sessionRow.workspace_id), script: sentence.text, sentences: [{ index: sentence.index, text: sentence.text, normalizedText: sentence.text.normalize('NFKC').toLowerCase(), voiceStartMs: sentence.startMs, voiceEndMs: sentence.endMs, durationMs: sentence.durationMs }], localAssets, usePexels: true, minClipDurationMs: sentence.durationMs, maxClipDurationMs: sentence.durationMs });
        const assignment = hybridResult.resolvedAssignments[0];
        const imported = assignment ? hybridResult.assets.find((asset) => asset.id === assignment.selectedAssetId) : undefined;
        if (imported && assignment && assignment.selectedSource !== 'LOCAL') {
          selectedAsset = imported;
          selectedSource = assignment.selectedSource;
          selectedSourceReason = assignment.reason || 'Existing HybridMediaService Pexels fallback; imported as ContentOS Asset';
        }
      }
      if (!selectedAsset) throw new Error(`NO_CANDIDATE_FOR_${sentence.id}`);
      const sourceInMs = candidate?.recommendedSourceInMs ?? Math.max(0, Math.min(selectedAsset.durationMs - sentence.durationMs, Math.round((selectedAsset.durationMs - sentence.durationMs) / 2)));
      const scene = sceneBySentence.get(sentence.index);
      timeline.push({ assetId: selectedAsset.id, sourcePath: selectedAsset.sourcePath, sourceInMs, sourceOutMs: sourceInMs + sentence.durationMs, durationMs: sentence.durationMs, transition: 'cut', sentenceIndex: sentence.index, sentenceId: sentence.id, sentenceText: sentence.text, ...(scene?.id ? { sceneId: scene.id } : {}), role: 'CONTENT', voiceStartMs: sentence.startMs, voiceEndMs: sentence.endMs, timelineStartMs, timelineEndMs: timelineStartMs + sentence.durationMs, selectionSource: 'AUTO', locked: false, revision: 1, sourceSegmentId: candidate?.sourceSegmentId || `segment-${sessionId}-${sentence.id}-${selectedAsset.id}`, matching: { matchedKeywords: selectedAsset.tags || [], matchScore: candidate?.semanticScore ?? 60, fallback: selectedSource !== 'LOCAL', matchingReason: selectedSourceReason, ...(scene?.visualIntent ? { visualIntent: scene.visualIntent } : {}), selectedSource } });
      cursor = timelineStartMs + sentence.durationMs;
    }
    const presentation = editorialPlan.presentationSettings || DEFAULT_PRESENTATION_SETTINGS_V1;
    const music = editorialPlan.audioPlan.path ? { path: editorialPlan.audioPlan.path, volume: editorialPlan.audioPlan.volume, loop: true, ...(editorialPlan.audioPlan.category ? { category: editorialPlan.audioPlan.category } : {}), ducking: { enabled: editorialPlan.audioPlan.duckingEnabled } } : undefined;
    const timelineBySentence = new Map(timeline.filter((clip) => clip.sentenceId).map((clip) => [clip.sentenceId!, clip]));
    const manifest: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', workspaceId: String(sessionRow.workspace_id), seed: 1, canvas: presentation.canvas, timeline, audio: { ...(sessionRow.voice_path ? { voicePath: String(sessionRow.voice_path) } : {}), ...(music ? { backgroundMusic: music } : {}), volume: 1 }, subtitles: editorialPlan.subtitles, subtitleStyle: presentation.subtitleStyle, presentationSettings: presentation, textOverlays: editorialPlan.textOverlays, metadata: { editMode: 'SCRIPT', sentences: sentences.map((sentence) => { const clip = timelineBySentence.get(sentence.id); const timelineStartMs = clip?.timelineStartMs ?? sentence.startMs; const timelineEndMs = clip?.timelineEndMs ?? timelineStartMs + sentence.durationMs; return { index: sentence.index, text: sentence.text, normalizedText: sentence.text.normalize('NFKC').toLowerCase(), voiceStartMs: sentence.startMs, voiceEndMs: sentence.endMs, timelineStartMs, timelineEndMs, durationMs: sentence.durationMs }; }), materialPoolSnapshotId: snapshot.id, v3SessionId: sessionId, v3Revision: 1, plannerVersion: editorialPlan.plannerVersion }, output: presentation.output };
    validateEditManifest(manifest);
    return this.persistManifest(sessionId, manifest);
  }

  async applyOperation(sessionId: string, operation: EditOperationV3): Promise<{ manifestId: string; revision: number }> {
    const current = await this.currentManifest(sessionId);
    const clipIndex = current.manifest.timeline.findIndex((clip) => clip.sentenceId === operation.sentenceId);
    if (clipIndex < 0) throw new Error('SCRIPT_EDITING_V3_SENTENCE_NOT_FOUND');
    const currentClip = current.manifest.timeline[clipIndex]!;
    if (currentClip.locked && operation.type !== 'UNLOCK_CLIP') throw new Error('SCRIPT_EDITING_V3_CLIP_LOCKED');
    const snapshot = await this.getSnapshot(String(current.session.material_pool_snapshot_id));
    const itemById = new Map(snapshot.items.map((item) => [item.assetId, item]));
    await this.addImportedAssetItems(String(current.session.workspace_id), [currentClip.assetId], itemById);
    if (operation.type === 'TRIM_SOURCE') {
      if (operation.sourceInMs < 0 || operation.sourceOutMs <= operation.sourceInMs) throw new Error('TRIM_SOURCE_OUT_OF_BOUNDS');
      if (operation.sourceOutMs - operation.sourceInMs !== currentClip.durationMs) throw new Error('TRIM_DURATION_MUST_MATCH_SENTENCE');
      const asset = itemById.get(currentClip.assetId); if (!asset || operation.sourceOutMs > asset.durationMs) throw new Error('TRIM_SOURCE_OUT_OF_BOUNDS');
    }
    let normalizedOperation: EditOperationV3 = operation;
    if (operation.type === 'REPLACE_CLIP' || operation.type === 'MANUAL_SELECT_CLIP') {
      const asset = itemById.get(operation.assetId); if (!asset) throw new Error('ASSET_NOT_IN_MATERIAL_POOL_SNAPSHOT');
      if (asset.availability !== 'VALID' || asset.disabled) throw new Error('ASSET_NOT_AVAILABLE_FOR_SELECTION');
      const maxSourceInMs = Math.max(0, asset.durationMs - currentClip.durationMs);
      const requestedSourceInMs = operation.sourceInMs ?? (operation.type === 'MANUAL_SELECT_CLIP' ? 0 : currentClip.sourceInMs);
      const sourceInMs = Math.min(maxSourceInMs, Math.max(0, requestedSourceInMs));
      if (sourceInMs + currentClip.durationMs > asset.durationMs) throw new Error('REPLACEMENT_SOURCE_TOO_SHORT');
      normalizedOperation = { ...operation, sourceInMs };
    }
    const adjustmentAssets: AdjustmentAsset[] = snapshot.items.map((item) => ({ id: item.assetId, durationMs: item.durationMs, sourcePath: item.sourcePath, originalName: item.fileName, tags: [...item.tags, ...(item.aiTags || [])] }));
    const next = applyQuickEditOperations(current.manifest, [normalizedOperation], adjustmentAssets);
    const clip = next.timeline[clipIndex]!;
    if (operation.type === 'TRIM_SOURCE') { clip.selectionSource = 'MANUAL'; clip.revision = Number(clip.revision || 1) + 1; }
    if (operation.type === 'REPLACE_CLIP' || operation.type === 'MANUAL_SELECT_CLIP') {
      clip.sourceSegmentId = operation.sourceSegmentId || `segment-${sessionId}-${operation.sentenceId}-${clip.assetId}-${operation.type === 'MANUAL_SELECT_CLIP' ? 'manual' : 'replace'}`;
      clip.selectionSource = operation.type === 'MANUAL_SELECT_CLIP' ? 'MANUAL' : 'HISTORY';
      clip.locked = false;
      clip.revision = Number(clip.revision || 1) + 1;
    }
    next.metadata = { ...(next.metadata || {}), v3Revision: Number(current.session.revision) + 1 };
    validateEditManifest(next);
    const result = await this.persistManifest(sessionId, next, normalizedOperation);
    if (operation.type === 'REPLACE_CLIP') {
      await this.incrementUsageStats(String(current.session.workspace_id), currentClip.assetId, { replaceCount: 1 });
      await this.incrementUsageStats(String(current.session.workspace_id), operation.assetId, { selectedCount: 1 });
    }
    if (operation.type === 'MANUAL_SELECT_CLIP') await this.incrementUsageStats(String(current.session.workspace_id), operation.assetId, { selectedCount: 1, manualSelectCount: 1 });
    return result;
  }

  private async persistManifest(sessionId: string, manifest: EditManifestV0, operation?: EditOperationV3): Promise<{ manifestId: string; revision: number }> {
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const session = (await client.query('select * from script_editing_v3_sessions where id=$1 for update', [sessionId])).rows[0] as PoolRow | undefined;
      if (!session) throw new Error('SCRIPT_EDITING_V3_SESSION_NOT_FOUND');
      const revision = Number(session.revision || 0) + 1;
      const previous = session.current_manifest_id ? String(session.current_manifest_id) : null;
      if (previous) await client.query("update edit_manifests set status='SUPERSEDED' where id=$1 and status='PERSISTED'", [previous]);
      const manifestId = `manifest-${randomUUID()}`;
      await client.query('insert into edit_manifests (id,project_id,workspace_id,revision,schema_version,manifest,manifest_digest,status,created_by,edit_operations) values ($1,null,$2,$3,$4,$5,$6,$7,$8,$9)', [manifestId, String(session.workspace_id), revision, 'EDIT_MANIFEST_V0', manifest, digestEditManifest(manifest), 'PERSISTED', 'script-editing-v3', operation ? JSON.stringify([operation]) : '[]']);
      await client.query("update script_editing_v3_sessions set current_manifest_id=$2,revision=$3,status='READY',updated_at=now() where id=$1", [sessionId, manifestId, revision]);
      await client.query('delete from clip_instances where session_id=$1', [sessionId]);
      for (const clip of manifest.timeline) if (clip.sentenceId) {
        const sourceOutMs = clip.sourceOutMs ?? clip.sourceInMs + clip.durationMs;
        let sourceSegmentId = clip.sourceSegmentId || null;
        if (sourceSegmentId) {
          const existing = (await client.query<{ id: string }>('select id from source_segments where snapshot_id=$1 and asset_id=$2 and source_in_ms=$3 and source_out_ms=$4 limit 1', [String(session.material_pool_snapshot_id), clip.assetId, clip.sourceInMs, sourceOutMs])).rows[0];
          sourceSegmentId = existing?.id || sourceSegmentId;
          await client.query('insert into source_segments (id,snapshot_id,asset_id,source_in_ms,source_out_ms,duration_ms,origin,evidence) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do update set snapshot_id=excluded.snapshot_id,asset_id=excluded.asset_id,source_in_ms=excluded.source_in_ms,source_out_ms=excluded.source_out_ms,duration_ms=excluded.duration_ms,origin=excluded.origin,evidence=excluded.evidence', [sourceSegmentId, String(session.material_pool_snapshot_id), clip.assetId, clip.sourceInMs, sourceOutMs, clip.durationMs, clip.selectionSource === 'MANUAL' ? 'MANUAL' : clip.selectionSource === 'HISTORY' ? 'JIANYING_HISTORY' : 'AI_RECOMMENDED', { sentenceId: clip.sentenceId, manifestId }]);
        }
        await client.query('insert into clip_instances (id,session_id,manifest_id,sentence_id,asset_id,source_segment_id,source_in_ms,source_out_ms,timeline_start_ms,duration_ms,locked,selection_source,review_status,revision) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', [`clip-${randomUUID()}`, sessionId, manifestId, clip.sentenceId, clip.assetId, sourceSegmentId, clip.sourceInMs, sourceOutMs, clip.timelineStartMs ?? 0, clip.durationMs, Boolean(clip.locked), clip.selectionSource || 'AUTO', clip.reviewStatus === 'MANUAL' ? 'REVIEWED' : 'UNREVIEWED', Number(clip.revision || revision)]);
      }
      if (operation) await client.query('insert into script_editing_v3_operations (id,session_id,manifest_id,operation) values ($1,$2,$3,$4)', [`operation-${randomUUID()}`, sessionId, manifestId, operation]);
      await client.query('commit');
      return { manifestId, revision };
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }
}
