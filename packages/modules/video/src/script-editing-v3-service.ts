import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { DEFAULT_PRESENTATION_SETTINGS_V1, validateEditManifest, type CandidateV3, type ClipInstanceV3, type EditManifestV0, type EditOperationV3, type ManifestClip, type MaterialPoolItemV3, type MaterialPoolSnapshotV3, type SentenceEditingCardV3 } from '../../../contracts/src/index.js';
import { digestEditManifest } from './quick-edit.js';
import { segmentScriptSentences } from './sentence-segmenter.js';
import type { AssetVisualProfileV3 } from '../../../contracts/src/index.js';

type SentenceV3 = { id: string; index: number; text: string; startMs: number; endMs: number; durationMs: number };
type PoolRow = Record<string, unknown>;

function tokens(value: string): string[] {
  const words = value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const word of [...words]) if (/^[\u3400-\u9fff]+$/u.test(word)) for (let size = 2; size <= Math.min(4, word.length); size += 1) for (let start = 0; start + size <= word.length; start += 1) words.push(word.slice(start, start + size));
  return [...new Set(words)];
}

function mapPoolItem(row: PoolRow): MaterialPoolItemV3 {
  const sourceRef = row.source_ref && typeof row.source_ref === 'object' ? row.source_ref as Record<string, unknown> : {};
  return { assetId: String(row.asset_id), sourcePath: String(row.source_path), fileName: String(row.file_name), durationMs: Number(row.duration_ms), width: Number(row.width || 0), height: Number(row.height || 0), ...(row.file_size == null ? {} : { fileSize: Number(row.file_size) }), ...(row.modified_at ? { modifiedAt: new Date(String(row.modified_at)).toISOString() } : {}), tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [], ...(row.thumbnail_key ? { thumbnailUrl: `/api/v1/video/local-media/thumbnails/${encodeURIComponent(String(row.asset_id))}` } : {}), gold: Boolean(row.stats_gold ?? row.gold), historyUseCount: Number(sourceRef.usageCount || 0), jianyingUseCount: Number(row.jianying_use_count || sourceRef.jianyingUseCount || 0), candidateCount: Number(row.candidate_count || 0), selectedCount: Number(row.selected_count || 0), finalUseCount: Number(row.final_use_count || 0), replaceCount: Number(row.replace_count || 0), manualSelectCount: Number(row.manual_select_count || 0), recentUseCount: Number(row.recent_use_count || 0), ...(row.stats_last_used_at ? { lastUsedAt: new Date(String(row.stats_last_used_at)).toISOString() } : sourceRef.lastUsedAt ? { lastUsedAt: String(sourceRef.lastUsedAt) } : {}) };
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

function buildQueries(sentence: SentenceV3): string[] {
  const text = sentence.text.replace(/[，。！？；：、“”‘’（）()]/gu, ' ').trim();
  const subject = text.split(/\s+/u).filter(Boolean).slice(0, 5).join(' ');
  return [...new Set([subject, `${subject} 真实场景`, `${subject} 近景细节`, `${subject} 人物活动`, `${subject} 环境全景`].filter(Boolean))].slice(0, 5);
}

export function buildVisualQueriesV3(text: string): string[] { return buildQueries({ id: 'sentence', index: 0, text, startMs: 0, endMs: 3_000, durationMs: 3_000 }); }

function scoreCandidate(sentence: SentenceV3, item: MaterialPoolItemV3, profile?: AssetVisualProfileV3): CandidateV3 {
  const queryTokens = new Set(tokens(`${sentence.text} ${buildQueries(sentence).join(' ')}`));
  const profileTags = profile?.tags.map((tag) => tag.tag) || [];
  const haystack = new Set(tokens(`${item.fileName} ${item.tags.join(' ')} ${profile?.summary || ''} ${profileTags.join(' ')}`));
  const matchingQueries = buildQueries(sentence).filter((query) => tokens(query).some((token) => haystack.has(token)));
  const matched = [...queryTokens].filter((token) => haystack.has(token));
  const semanticScore = queryTokens.size ? Math.min(100, Math.round((matched.length / queryTokens.size) * 100)) : 0;
  const historyBonus = item.historyUseCount ? Math.max(0, 8 - item.historyUseCount) : 8;
  const finalScore = semanticScore + historyBonus + (item.gold ? 12 : 0);
  const sourceInMs = Math.max(0, Math.min(item.durationMs - sentence.durationMs, Math.round(item.durationMs * 0.25)));
  return { assetId: item.assetId, fileName: item.fileName, recommendedSourceInMs: sourceInMs, recommendedSourceOutMs: sourceInMs + sentence.durationMs, semanticScore, matchingQueries, visualEvidence: [...item.tags, ...profileTags].filter((tag) => matched.includes(tag.toLowerCase())).slice(0, 5), historyBonus, ...(item.historyUseCount === undefined ? {} : { historyUseCount: item.historyUseCount }), ...(item.gold === undefined ? {} : { gold: item.gold }), finalScore };
}

export function rankMaterialCandidateV3(input: { text: string; durationMs: number }, item: MaterialPoolItemV3): CandidateV3 { return scoreCandidate({ id: 'sentence', index: 0, text: input.text, startMs: 0, endMs: input.durationMs, durationMs: input.durationMs }, item); }

export class JianyingDraftImporter {
  constructor(private readonly db: Pool) {}

  async importReadOnly(workspaceId: string, draftPath: string): Promise<{ id: string; draftId: string; draftName: string; usageCount: number }> {
    const absolutePath = resolve(draftPath);
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
    const parsed: Record<string, unknown> = Object.assign({}, ...payloads);
    const draftId = String(parsed.draft_id || parsed.draftId || basename(absolutePath));
    const draftName = String(parsed.draft_name || parsed.draftName || basename(rootPath));
    const materialPaths = new Map<string, string>();
    const pathValue = (row: Record<string, unknown>): string | undefined => {
      const value = row.path || row.local_material_path || row.file_path || row.material_path;
      if (typeof value !== 'string' || !value.trim()) return undefined;
      const normalized = value.replace(/^file:\/\//u, '');
      return isAbsolute(normalized) ? resolve(normalized) : resolve(rootPath, normalized);
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
      const localAsset = (await this.db.query<{ file_id: string }>('select f.file_id from local_media_scan_files f join local_media_scans s on s.id=f.scan_id where s.workspace_id=$1 and s.status=\'SUCCEEDED\' and f.available=true and lower(f.source_path)=lower($2) order by s.scanned_at desc nulls last limit 1', [workspaceId, usage.assetId])).rows[0];
      if (localAsset) await this.db.query(`insert into script_editing_v3_asset_usage_stats (workspace_id,asset_id,jianying_use_count) values ($1,$2,1)
        on conflict (workspace_id,asset_id) do update set jianying_use_count=script_editing_v3_asset_usage_stats.jianying_use_count+1,updated_at=now()`, [workspaceId, localAsset.file_id]);
    }
    return { id: importId, draftId, draftName, usageCount: usages.length };
  }
}

export class ScriptEditingV3Service {
  constructor(private readonly db: Pool) {}

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

  async persistVisualProfile(profile: AssetVisualProfileV3): Promise<void> {
    await this.db.query('insert into asset_visual_profiles (asset_id,summary,profile,provider,model_name,model_version,prompt_version,analysis_version,status,error) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,null) on conflict (asset_id) do update set summary=excluded.summary,profile=excluded.profile,provider=excluded.provider,model_name=excluded.model_name,model_version=excluded.model_version,prompt_version=excluded.prompt_version,analysis_version=excluded.analysis_version,status=excluded.status,error=null,updated_at=now()', [profile.assetId, profile.summary, profile, profile.modelProvider, profile.modelName, profile.modelVersion, profile.promptVersion, profile.analysisVersion, 'READY']);
    for (const tag of profile.tags) await this.db.query('insert into asset_tag_evidence (id,asset_id,tag,evidence_kind,confidence,timestamps_ms) values ($1,$2,$3,$4,$5,$6) on conflict (asset_id,tag,evidence_kind) do update set confidence=excluded.confidence,timestamps_ms=excluded.timestamps_ms', [`tag-evidence-${randomUUID()}`, profile.assetId, tag.tag, 'QWEN_VL', tag.confidence, JSON.stringify(tag.timestampsMs)]);
  }

  async createMaterialPoolSnapshot(input: { workspaceId: string; sourceRootIds?: string[]; sourceKind?: 'MANUAL' | 'JIANYING_DRAFT' }): Promise<MaterialPoolSnapshotV3> {
    const roots = input.sourceRootIds?.filter(Boolean) || [];
    const params: unknown[] = [input.workspaceId];
    const rootPlaceholder = roots.length ? `$${params.push(roots)}::text[]` : undefined;
    const rootClause = rootPlaceholder ? ` and s.source_root_id = any(${rootPlaceholder})` : '';
    const result = input.sourceKind === 'JIANYING_DRAFT' ? { rows: [] as PoolRow[] } : await this.db.query(`select distinct on (f.file_id) f.file_id, f.file_name, f.source_path, f.duration_ms, f.width, f.height, f.file_size, f.modified_at, coalesce(i.tags, f.tags) as tags, i.thumbnail_key, i.usage_count, i.last_used_at, s.source_root_id from local_media_scan_files f join local_media_scans s on s.id=f.scan_id left join local_media_index i on i.file_id=f.file_id where s.workspace_id=$1 and s.status='SUCCEEDED' and f.available=true${rootClause} order by f.file_id, s.scanned_at desc nulls last`, params);
    const deduped = new Map<string, PoolRow>();
    for (const row of result.rows as PoolRow[]) {
      const canonical = resolve(String(row.source_path)).toLowerCase();
      const key = `${canonical}:${Number(row.file_size || 0)}:${Number(row.duration_ms)}`;
      if (!deduped.has(key)) deduped.set(key, { ...row, canonical_path: canonical, asset_id: String(row.file_id), source_ref: { sourceRootId: String(row.source_root_id), usageCount: Number(row.usage_count || 0), ...(row.last_used_at ? { lastUsedAt: new Date(String(row.last_used_at)).toISOString() } : {}) }, gold: false });
    }
    if (input.sourceKind === 'JIANYING_DRAFT') {
      const draftRows = await this.db.query(`select distinct on (f.file_id) f.file_id,f.file_name,f.source_path,f.duration_ms,f.width,f.height,f.file_size,f.modified_at,coalesce(i.tags,f.tags) as tags,i.thumbnail_key,i.usage_count,i.last_used_at,s.source_root_id,count(*) over (partition by f.file_id)::int as jianying_usage_count,d.draft_id,d.draft_name
        from jianying_asset_usages u join jianying_draft_imports d on d.id=u.draft_import_id join local_media_scan_files f on lower(f.source_path)=lower(u.asset_id) join local_media_scans s on s.id=f.scan_id left join local_media_index i on i.file_id=f.file_id
        where d.workspace_id=$1 and d.status='IMPORTED' and s.status='SUCCEEDED' and f.available=true order by f.file_id,d.imported_at desc nulls last,s.scanned_at desc nulls last`, [input.workspaceId]);
      for (const row of draftRows.rows as PoolRow[]) {
        const canonical = resolve(String(row.source_path)).toLowerCase();
        const key = `${canonical}:${Number(row.file_size || 0)}:${Number(row.duration_ms)}`;
        if (!deduped.has(key)) deduped.set(key, { ...row, canonical_path: canonical, asset_id: String(row.file_id), source_ref: { sourceRootId: String(row.source_root_id), usageCount: Number(row.usage_count || 0), jianyingUseCount: Number(row.jianying_usage_count || 0), draftId: String(row.draft_id), draftName: String(row.draft_name), ...(row.last_used_at ? { lastUsedAt: new Date(String(row.last_used_at)).toISOString() } : {}) }, gold: false });
      }
    }
    if (!deduped.size) throw new Error('MATERIAL_POOL_EMPTY');
    const nextRevision = Number((await this.db.query<{ revision: number }>('select coalesce(max(revision),0)+1 as revision from material_pool_snapshots where workspace_id=$1', [input.workspaceId])).rows[0]?.revision || 1);
    const snapshotId = `material-pool-snapshot-${randomUUID()}`;
    await this.db.query('insert into material_pool_snapshots (id,workspace_id,revision,source_spec) values ($1,$2,$3,$4)', [snapshotId, input.workspaceId, nextRevision, { sourceKind: input.sourceKind || 'MANUAL', sourceRootIds: roots }]);
    for (const row of deduped.values()) await this.db.query('insert into material_pool_items (snapshot_id,asset_id,canonical_path,source_path,file_name,duration_ms,width,height,file_size,modified_at,tags,source_kind,source_ref,thumbnail_key,gold) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [snapshotId, String(row.asset_id), String(row.canonical_path), String(row.source_path), String(row.file_name), Number(row.duration_ms), Number(row.width || 0), Number(row.height || 0), row.file_size == null ? null : Number(row.file_size), row.modified_at || null, JSON.stringify(row.tags || []), input.sourceKind || 'MANUAL', row.source_ref || {}, row.thumbnail_key || null, Boolean(row.gold)]);
    return this.getSnapshot(snapshotId);
  }

  async getSnapshot(snapshotId: string): Promise<MaterialPoolSnapshotV3> {
    const header = (await this.db.query('select * from material_pool_snapshots where id=$1', [snapshotId])).rows[0] as PoolRow | undefined;
    if (!header) throw new Error('MATERIAL_POOL_SNAPSHOT_NOT_FOUND');
    const rows = await this.db.query('select i.*,u.jianying_use_count,u.candidate_count,u.selected_count,u.final_use_count,u.replace_count,u.manual_select_count,u.recent_use_count,u.gold as stats_gold,u.last_used_at as stats_last_used_at from material_pool_items i left join script_editing_v3_asset_usage_stats u on u.workspace_id=$2 and u.asset_id=i.asset_id where i.snapshot_id=$1 order by i.file_name,i.asset_id', [snapshotId, header.workspace_id]);
    return { id: String(header.id), workspaceId: String(header.workspace_id), revision: Number(header.revision), items: (rows.rows as PoolRow[]).map(mapPoolItem), createdAt: new Date(String(header.created_at)).toISOString() };
  }

  async createSession(input: { workspaceId: string; snapshotId: string; script: string; sentences?: Array<{ text: string; startMs?: number | undefined; endMs?: number | undefined; durationMs?: number | undefined }> | undefined }): Promise<{ id: string; status: string; revision: number }> {
    const sentences = input.sentences?.length ? input.sentences.map((row, index) => ({ id: `sentence-${index}`, index, text: row.text.trim(), startMs: Number(row.startMs ?? 0), endMs: Number(row.endMs ?? (Number(row.startMs ?? 0) + Number(row.durationMs ?? 3_000))), durationMs: Number(row.durationMs ?? (Number(row.endMs ?? 3_000) - Number(row.startMs ?? 0))) })) : segmentScriptSentences(input.script).map((row, index) => ({ id: `sentence-${index}`, index, text: row.text, startMs: index * 3_000, endMs: (index + 1) * 3_000, durationMs: 3_000 }));
    if (!sentences.length) throw new Error('SCRIPT_SEGMENTATION_EMPTY');
    const snapshot = await this.getSnapshot(input.snapshotId);
    if (snapshot.workspaceId !== input.workspaceId) throw new Error('MATERIAL_POOL_SCOPE_MISMATCH');
    const id = `script-editing-v3-${randomUUID()}`;
    await this.db.query('insert into script_editing_v3_sessions (id,workspace_id,material_pool_snapshot_id,script,sentences) values ($1,$2,$3,$4,$5)', [id, input.workspaceId, input.snapshotId, input.script, JSON.stringify(sentences)]);
    for (const sentence of sentences) for (const query of buildQueries(sentence)) await this.db.query('insert into visual_queries (id,session_id,sentence_id,query,model,prompt_version) values ($1,$2,$3,$4,$5,$6)', [`visual-query-${randomUUID()}`, id, sentence.id, query, 'rules-v3', 'visual-query-v1']);
    await this.rankCandidates(id, snapshot, sentences);
    return { id, status: 'DRAFT', revision: 1 };
  }

  private async rankCandidates(sessionId: string, snapshot: MaterialPoolSnapshotV3, sentences: SentenceV3[]): Promise<void> {
    const profileRows = await this.db.query<{ asset_id: string; profile: AssetVisualProfileV3 }>('select asset_id,profile from asset_visual_profiles where asset_id = any($1::text[]) and status=\'READY\'', [snapshot.items.map((item) => item.assetId)]);
    const profiles = new Map(profileRows.rows.map((row) => [row.asset_id, row.profile]));
    for (const sentence of sentences) {
      const ranked = snapshot.items.filter((item) => item.durationMs >= sentence.durationMs).map((item) => scoreCandidate(sentence, item, profiles.get(item.assetId))).sort((a, b) => b.finalScore - a.finalScore || a.assetId.localeCompare(b.assetId)).slice(0, 5);
      for (const ranking of ranked) {
        const inserted = await this.db.query('insert into candidate_rankings (id,session_id,sentence_id,asset_id,ranking) values ($1,$2,$3,$4,$5) on conflict (session_id,sentence_id,asset_id) do update set ranking=excluded.ranking,created_at=now() returning (xmax = 0) as inserted', [`candidate-${randomUUID()}`, sessionId, sentence.id, ranking.assetId, ranking]);
        if (inserted.rows[0]?.inserted) await this.incrementUsageStats(snapshot.workspaceId, ranking.assetId, { candidateCount: 1 });
      }
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
    const sentences = sentenceRows(row.sentences);
    const cards = sentences.map((sentence) => {
      const clip = clips.get(sentence.id);
      const cardClip: ClipInstanceV3 | null = clip ? { id: `clip-${sessionId}-${sentence.id}`, sentenceId: sentence.id, ...(clip.sourceSegmentId ? { sourceSegmentId: clip.sourceSegmentId } : {}), assetId: clip.assetId, sourceInMs: clip.sourceInMs, sourceOutMs: clip.sourceOutMs ?? clip.sourceInMs + clip.durationMs, timelineStartMs: clip.timelineStartMs ?? sentence.startMs, durationMs: clip.durationMs, locked: Boolean(clip.locked), selectionSource: clip.selectionSource || 'AUTO', revision: Number(clip.revision || row.revision) } : null;
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
    const previousManifest = sessionRow.current_manifest_id ? (await this.db.query('select manifest from edit_manifests where id=$1', [sessionRow.current_manifest_id])).rows[0]?.manifest as EditManifestV0 | undefined : undefined;
    const previousBySentence = new Map((previousManifest?.timeline || []).filter((clip) => Boolean(clip.sentenceId)).map((clip) => [clip.sentenceId!, clip]));
    let cursor = 0;
    const timeline: ManifestClip[] = [];
    for (const sentence of sentences) {
      const locked = previousBySentence.get(sentence.id);
      if (locked?.locked) { timeline.push({ ...locked }); cursor += locked.durationMs; continue; }
      const candidate = snapshot.items.filter((item) => item.durationMs >= sentence.durationMs).map((item) => scoreCandidate(sentence, item)).sort((a, b) => b.finalScore - a.finalScore)[0];
      if (!candidate) throw new Error(`NO_CANDIDATE_FOR_${sentence.id}`);
      const asset = snapshot.items.find((item) => item.assetId === candidate.assetId)!;
      const sourceInMs = candidate.recommendedSourceInMs;
      timeline.push({ assetId: asset.assetId, sourcePath: asset.sourcePath, sourceInMs, sourceOutMs: sourceInMs + sentence.durationMs, durationMs: sentence.durationMs, transition: 'cut', sentenceIndex: sentence.index, sentenceId: sentence.id, sentenceText: sentence.text, timelineStartMs: cursor, timelineEndMs: cursor + sentence.durationMs, selectionSource: 'AUTO', locked: false, revision: 1, sourceSegmentId: `segment-${sessionId}-${sentence.id}`, matching: { matchedKeywords: asset.tags, matchScore: candidate.semanticScore, fallback: false, matchingReason: 'V3 candidate ranking', selectedSource: 'LOCAL' } });
      cursor += sentence.durationMs;
    }
    const manifest: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', workspaceId: String(sessionRow.workspace_id), seed: 1, canvas: DEFAULT_PRESENTATION_SETTINGS_V1.canvas, timeline, audio: { volume: 1 }, subtitles: sentences.map((sentence) => ({ text: sentence.text, startMs: sentence.startMs, endMs: sentence.endMs })), presentationSettings: DEFAULT_PRESENTATION_SETTINGS_V1, metadata: { editMode: 'SCRIPT', sentences: sentences.map((sentence) => ({ index: sentence.index, text: sentence.text, normalizedText: sentence.text.normalize('NFKC').toLowerCase(), timelineStartMs: sentence.startMs, timelineEndMs: sentence.endMs, durationMs: sentence.durationMs })), materialPoolSnapshotId: snapshot.id, v3SessionId: sessionId, v3Revision: 1, plannerVersion: 'script-editing-v3-unified' }, output: DEFAULT_PRESENTATION_SETTINGS_V1.output };
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
    const next = structuredClone(current.manifest);
    const clip = next.timeline[clipIndex]!;
    if (operation.type === 'LOCK_CLIP' || operation.type === 'UNLOCK_CLIP') clip.locked = operation.type === 'LOCK_CLIP';
    if (operation.type === 'TRIM_SOURCE') {
      if (operation.sourceOutMs - operation.sourceInMs !== clip.durationMs) throw new Error('TRIM_DURATION_MUST_MATCH_SENTENCE');
      const asset = itemById.get(clip.assetId); if (!asset || operation.sourceOutMs > asset.durationMs) throw new Error('TRIM_SOURCE_OUT_OF_BOUNDS');
      clip.sourceInMs = operation.sourceInMs; clip.sourceOutMs = operation.sourceOutMs; clip.revision = Number(clip.revision || 1) + 1; clip.selectionSource = 'MANUAL';
    }
    if (operation.type === 'REPLACE_CLIP' || operation.type === 'MANUAL_SELECT_CLIP') {
      const asset = itemById.get(operation.assetId); if (!asset) throw new Error('ASSET_NOT_IN_MATERIAL_POOL_SNAPSHOT');
      const sourceInMs = operation.sourceInMs ?? 0; if (sourceInMs + clip.durationMs > asset.durationMs) throw new Error('REPLACEMENT_SOURCE_TOO_SHORT');
      clip.assetId = asset.assetId; clip.sourcePath = asset.sourcePath; clip.sourceInMs = sourceInMs; clip.sourceOutMs = sourceInMs + clip.durationMs; clip.selectionSource = operation.type === 'MANUAL_SELECT_CLIP' ? 'MANUAL' : 'HISTORY'; clip.locked = false; clip.revision = Number(clip.revision || 1) + 1;
    }
    next.metadata = { ...(next.metadata || {}), v3Revision: Number(current.session.revision) + 1 };
    validateEditManifest(next);
    const result = await this.persistManifest(sessionId, next, operation);
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
      for (const clip of manifest.timeline) if (clip.sentenceId) await client.query('insert into clip_instances (id,session_id,manifest_id,sentence_id,asset_id,source_segment_id,source_in_ms,source_out_ms,timeline_start_ms,duration_ms,locked,selection_source,revision) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [`clip-${randomUUID()}`, sessionId, manifestId, clip.sentenceId, clip.assetId, clip.sourceSegmentId || null, clip.sourceInMs, clip.sourceOutMs ?? clip.sourceInMs + clip.durationMs, clip.timelineStartMs ?? 0, clip.durationMs, Boolean(clip.locked), clip.selectionSource || 'AUTO', Number(clip.revision || revision)]);
      if (operation) await client.query('insert into script_editing_v3_operations (id,session_id,manifest_id,operation) values ($1,$2,$3,$4)', [`operation-${randomUUID()}`, sessionId, manifestId, operation]);
      await client.query('commit');
      return { manifestId, revision };
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }
}
