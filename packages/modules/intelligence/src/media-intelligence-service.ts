import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Pool } from 'pg';
import { generateShotKeyframe } from '../../../infrastructure/ffmpeg/src/index.js';
import { cosineSimilarity, hybridSemanticScore, semanticTokens } from '../../video/src/index.js';
import {
  INTELLIGENT_EDITING_V15_ANALYSIS_VERSION,
  INTELLIGENT_EDITING_V15_RUN_SCHEMA,
  validateMediaAnalysisAsrSegmentV1,
  validateMediaAnalysisEmbeddingV1,
  validateMediaAnalysisKeyframeV1,
  validateMediaAnalysisRunV1,
  validateMediaAnalysisShotV1,
  validateMediaAnalysisVisionResultV1,
  validateTechnicalMediaAnalysisV1,
  type MediaAnalysisAsrSegmentV1,
  type MediaAnalysisCapability,
  type MediaAnalysisEmbeddingV1,
  type MediaAnalysisKeyframeV1,
  type MediaAnalysisRunV1,
  type MediaAnalysisSearchResultV1,
  type MediaAnalysisShotV1,
  type MediaAnalysisVisionResultV1,
  type TechnicalMediaAnalysisV1,
} from '../../../contracts/src/index.js';
import type { LocalStorageProvider } from '../../../infrastructure/storage/src/index.js';
import type { IntelligenceProviders } from './providers.js';

export const MEDIA_ANALYSIS = 'MEDIA_ANALYSIS' as const;
export interface CreateMediaAnalysisInput { id?: string; projectId: string; assetId: string; capabilities?: MediaAnalysisCapability[]; providerMode?: 'FAKE' | 'REAL'; idempotencyKey?: string; }
export interface MediaIntelligenceServiceOptions { analysisVersion?: string; pipelineVersion?: string; storage?: LocalStorageProvider; ffmpegPath?: string; keyframeRoot?: string; semanticWeight?: number; lexicalWeight?: number; embeddingModelVersion?: string; }
const DEFAULT_CAPABILITIES: MediaAnalysisCapability[] = ['TECHNICAL', 'SHOTS', 'KEYFRAMES', 'ASR', 'VISION', 'EMBEDDING'];
type AssetRow = { id: string; metadata: Record<string, unknown>; storage_key: string; checksum: string | null };
type RunRow = Record<string, unknown> & { metadata?: unknown; storage_key?: unknown; checksum?: unknown };

function mapRun(row: Record<string, unknown>): MediaAnalysisRunV1 {
  const value: MediaAnalysisRunV1 = {
    schemaVersion: INTELLIGENT_EDITING_V15_RUN_SCHEMA,
    id: String(row.id), projectId: String(row.project_id), assetId: String(row.asset_id), status: String(row.status) as MediaAnalysisRunV1['status'],
    capabilities: (Array.isArray(row.capabilities) ? row.capabilities : []) as MediaAnalysisCapability[], providerMode: String(row.provider_mode) as MediaAnalysisRunV1['providerMode'],
    analysisVersion: String(row.analysis_version), sourceChecksum: row.source_checksum ? String(row.source_checksum) : null, ...(row.pipeline_version ? { pipelineVersion: String(row.pipeline_version) } : {}),
    idempotencyKey: String(row.idempotency_key), jobId: row.job_id ? String(row.job_id) : null, attemptCount: Number(row.attempt_count),
    error: row.error && typeof row.error === 'object' ? row.error as MediaAnalysisRunV1['error'] : null,
    createdAt: new Date(String(row.created_at)).toISOString(), startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null, finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
  };
  validateMediaAnalysisRunV1(value);
  return value;
}

function capability(input: MediaAnalysisCapability[], name: MediaAnalysisCapability): boolean { return input.includes(name); }
function safeMetadata(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function errorValue(error: unknown): { code: string; message: string } { const candidate = error as { code?: unknown }; return { code: typeof candidate?.code === 'string' ? candidate.code : 'MEDIA_ANALYSIS_FAILED', message: error instanceof Error ? error.message : 'Media analysis failed' }; }
function jsonArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function containedPath(root: string, relativePath: string): string {
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, relativePath);
  if (candidate !== absoluteRoot && !candidate.toLowerCase().startsWith(`${absoluteRoot.toLowerCase()}${sep}`)) throw new Error('INTELLIGENCE_STORAGE_PATH_OUTSIDE_ROOT');
  return candidate;
}
function sourcePath(storage: LocalStorageProvider | undefined, storageKey: string): string | undefined { return storage ? storage.objectPath(storageKey) : undefined; }
function overlapShot(shots: MediaAnalysisShotV1[], startMs: number, endMs: number): string | null {
  return shots.find((shot) => Math.min(endMs, shot.sourceOutMs) > Math.max(startMs, shot.sourceInMs))?.id || null;
}

export class MediaIntelligenceService {
  constructor(private readonly db: Pool, private readonly providers: IntelligenceProviders, private readonly options: MediaIntelligenceServiceOptions = {}) {}

  async createRun(input: CreateMediaAnalysisInput): Promise<MediaAnalysisRunV1> {
    const capabilities = [...new Set(input.capabilities?.length ? input.capabilities : DEFAULT_CAPABILITIES)];
    if (input.providerMode === 'REAL' && this.providers.mode !== 'REAL') throw Object.assign(new Error('REAL_INTELLIGENCE_PROVIDER_DISABLED'), { code: 'REAL_INTELLIGENCE_PROVIDER_DISABLED', retryable: false });
    const asset = await this.db.query<AssetRow>('select a.id, a.metadata, a.storage_key, a.checksum from assets a left join project_assets pa on pa.asset_id = a.id and pa.project_id = $1 where a.id = $2 and a.lifecycle = $3 and (a.project_id = $1 or pa.project_id = $1)', [input.projectId, input.assetId, 'READY']);
    if (!asset.rows[0]) throw new Error('MEDIA_ANALYSIS_ASSET_NOT_FOUND');
    const checksum = asset.rows[0].checksum || null;
    const analysisVersion = this.options.analysisVersion || INTELLIGENT_EDITING_V15_ANALYSIS_VERSION;
    const idempotencyKey = input.idempotencyKey?.trim() || `media-analysis:${input.projectId}:${input.assetId}:${checksum || 'no-checksum'}:${analysisVersion}:${capabilities.join(',')}`;
    const result = await this.db.query('insert into media_analysis_runs (id, project_id, asset_id, status, capabilities, provider_mode, analysis_version, source_checksum, pipeline_version, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (project_id,idempotency_key) do nothing returning *', [input.id || `analysis-${randomUUID()}`, input.projectId, input.assetId, 'QUEUED', capabilities, input.providerMode || this.providers.mode, analysisVersion, checksum, this.options.pipelineVersion || 'intelligent-editing-v15-core-closure-1', idempotencyKey]);
    if (result.rows[0]) return mapRun(result.rows[0] as Record<string, unknown>);
    const existing = await this.db.query('select * from media_analysis_runs where project_id = $1 and idempotency_key = $2', [input.projectId, idempotencyKey]);
    if (!existing.rows[0]) throw new Error('MEDIA_ANALYSIS_IDEMPOTENCY_CONFLICT');
    return mapRun(existing.rows[0] as Record<string, unknown>);
  }

  async attachJob(runId: string, jobId: string): Promise<void> { await this.db.query('update media_analysis_runs set job_id = $2 where id = $1', [runId, jobId]); }
  async getRun(projectId: string, runId: string): Promise<MediaAnalysisRunV1 | null> { const result = await this.db.query('select * from media_analysis_runs where project_id = $1 and id = $2', [projectId, runId]); return result.rows[0] ? mapRun(result.rows[0] as Record<string, unknown>) : null; }

  async markCancelled(runId: string, error = { code: 'MEDIA_ANALYSIS_CANCELLED', message: 'Media analysis cancelled' }): Promise<void> { await this.db.query("update media_analysis_runs set status='CANCELLED', error=$2, finished_at=coalesce(finished_at,now()) where id=$1 and status not in ('SUCCEEDED','FAILED','STALE')", [runId, error]); }

  async reconcileStaleRuns(): Promise<number> {
    const result = await this.db.query(`update media_analysis_runs r
      set status = case when j.state='CANCELLED' then 'CANCELLED' when j.state='FAILED' then 'FAILED' else 'QUEUED' end,
          error = case when j.state='CANCELLED' then '{"code":"MEDIA_ANALYSIS_JOB_CANCELLED","message":"Media analysis job was cancelled"}'::jsonb
                       when j.state='FAILED' then '{"code":"MEDIA_ANALYSIS_JOB_FAILED","message":"Media analysis job failed or its lease expired"}'::jsonb
                       else '{"code":"MEDIA_ANALYSIS_JOB_REQUEUED","message":"Media analysis job was requeued after lease reconciliation"}'::jsonb end,
          finished_at = case when j.state in ('FAILED','CANCELLED') then coalesce(r.finished_at, now()) else null end
      from jobs j
      where r.job_id=j.id and j.type=$1 and r.status='RUNNING' and j.state in ('QUEUED','RETRY_WAIT','FAILED','CANCELLED')
      returning r.id`, [MEDIA_ANALYSIS]);
    return result.rowCount || 0;
  }

  async analyzeRun(runId: string, signal?: AbortSignal): Promise<MediaAnalysisRunV1> {
    const selected = await this.db.query('select r.*, a.metadata, a.storage_key, a.checksum from media_analysis_runs r join assets a on a.id = r.asset_id where r.id = $1', [runId]);
    const row = selected.rows[0] as RunRow | undefined;
    if (!row) throw new Error('MEDIA_ANALYSIS_RUN_NOT_FOUND');
    const currentChecksum = row.checksum ? String(row.checksum) : null;
    if (row.status === 'SUCCEEDED' && String(row.source_checksum || '') === String(currentChecksum || '')) return mapRun(row);
    if (row.status === 'SUCCEEDED' && String(row.source_checksum || '') !== String(currentChecksum || '')) {
      await this.db.query("update media_analysis_runs set status='STALE', finished_at=coalesce(finished_at,now()), error=$2 where id=$1", [runId, { code: 'MEDIA_ANALYSIS_SOURCE_CHANGED', message: 'Asset checksum no longer matches this analysis' }]);
      throw new Error('MEDIA_ANALYSIS_STALE');
    }
    const run = mapRun(row);
    if (run.providerMode === 'REAL' && this.providers.mode !== 'REAL') throw Object.assign(new Error('REAL_INTELLIGENCE_PROVIDER_DISABLED'), { code: 'REAL_INTELLIGENCE_PROVIDER_DISABLED', retryable: false });
    const metadata = safeMetadata(row.metadata);
    const source = sourcePath(this.options.storage, String(row.storage_key));
    if (this.providers.mode === 'REAL' && (!source || !(await stat(source).then((details) => details.isFile()).catch(() => false)))) throw Object.assign(new Error('MEDIA_ANALYSIS_SOURCE_UNAVAILABLE'), { code: 'MEDIA_ANALYSIS_SOURCE_UNAVAILABLE', retryable: false });
    await this.db.query("update media_analysis_runs set status='RUNNING', source_checksum=$2, pipeline_version=$3, started_at=coalesce(started_at,now()), attempt_count=attempt_count+1, error=null, finished_at=null where id=$1", [runId, currentChecksum, this.options.pipelineVersion || 'intelligent-editing-v15-core-closure-1']);
    try {
      signal?.throwIfAborted();
      const technicalBase = await this.providers.technical.probe({ assetId: run.assetId, runId, metadata, ...(source ? { sourcePath: source } : {}), ...(signal ? { signal } : {}) });
      const technical: TechnicalMediaAnalysisV1 = { runId, assetId: run.assetId, ...technicalBase };
      validateTechnicalMediaAnalysisV1(technical);
      await this.db.query('insert into media_analysis_technical (run_id,asset_id,duration_ms,width,height,fps,format,video_codec,audio_codec,has_audio,provider,model_version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (run_id) do update set duration_ms=excluded.duration_ms,width=excluded.width,height=excluded.height,fps=excluded.fps,format=excluded.format,video_codec=excluded.video_codec,audio_codec=excluded.audio_codec,has_audio=excluded.has_audio,provider=excluded.provider,model_version=excluded.model_version', [runId, run.assetId, technical.durationMs, technical.width, technical.height, technical.fps, technical.format, technical.videoCodec, technical.audioCodec, technical.hasAudio, technical.provider, technical.modelVersion]);

      const detected = await this.providers.shots.detect({ assetId: run.assetId, runId, ...(source ? { sourcePath: source } : {}), durationMs: technical.durationMs, ...(signal ? { signal } : {}) });
      const shots: MediaAnalysisShotV1[] = detected.map((shot, index) => ({ id: `shot-${runId}-${index}`, runId, assetId: run.assetId, shotIndex: index, sourceInMs: Math.round(shot.sourceInMs), sourceOutMs: Math.round(shot.sourceOutMs), confidence: shot.confidence, detectionVersion: shot.detectionVersion }));
      if (!shots.length) throw Object.assign(new Error('SHOT_DETECTION_EMPTY'), { code: 'SHOT_DETECTION_EMPTY', retryable: false });
      for (const shot of shots) { validateMediaAnalysisShotV1(shot); await this.db.query('insert into media_analysis_shots (id,run_id,asset_id,shot_index,source_in_ms,source_out_ms,confidence,detection_version) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do update set source_in_ms=excluded.source_in_ms,source_out_ms=excluded.source_out_ms,confidence=excluded.confidence,detection_version=excluded.detection_version', [shot.id, shot.runId, shot.assetId, shot.shotIndex, shot.sourceInMs, shot.sourceOutMs, shot.confidence, shot.detectionVersion]); }
      await this.db.query('delete from media_analysis_shots where run_id=$1 and id <> all($2::text[])', [runId, shots.map((shot) => shot.id)]);

      if (capability(run.capabilities, 'KEYFRAMES')) await this.generateKeyframes(run, shots, source, signal);
      if (capability(run.capabilities, 'ASR')) {
        const segments = await this.providers.asr.transcribe({ assetId: run.assetId, runId, durationMs: technical.durationMs, metadata, ...(signal ? { signal } : {}) });
        for (const [index, item] of segments.entries()) {
          signal?.throwIfAborted();
          const segmentIndex = item.segmentIndex ?? index;
          const segment: MediaAnalysisAsrSegmentV1 = { id: `asr-${runId}-${segmentIndex}`, runId, assetId: run.assetId, ...item, segmentIndex };
          validateMediaAnalysisAsrSegmentV1(segment);
          await this.db.query('insert into media_analysis_asr_segments (id,run_id,asset_id,segment_index,start_ms,end_ms,text,speaker,confidence,provider,model_version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (run_id,segment_index) do update set start_ms=excluded.start_ms,end_ms=excluded.end_ms,text=excluded.text,speaker=excluded.speaker,confidence=excluded.confidence,provider=excluded.provider,model_version=excluded.model_version', [segment.id, segment.runId, segment.assetId, segmentIndex, segment.startMs, segment.endMs, segment.text, segment.speaker, segment.confidence, segment.provider, segment.modelVersion]);
          if (capability(run.capabilities, 'EMBEDDING')) await this.persistEmbedding(run, 'ASR', segment.id, segment.text, this.providers.embedding, undefined, signal);
        }
      }
      if (capability(run.capabilities, 'VISION')) {
        const visionItems = await this.providers.vision.analyze({ assetId: run.assetId, runId, shots, metadata, ...(signal ? { signal } : {}) });
        for (const [index, item] of visionItems.entries()) {
          signal?.throwIfAborted();
          const shotId = item.shotId || shots[index]?.id || null;
          const result: MediaAnalysisVisionResultV1 = { id: `vision-${runId}-${shotId || index}`, runId, assetId: run.assetId, ...item, shotId };
          validateMediaAnalysisVisionResultV1(result);
          await this.db.query('insert into media_analysis_vision_results (id,run_id,asset_id,shot_id,summary,tags,normalized,provider,model_version,prompt_version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (id) do update set shot_id=excluded.shot_id,summary=excluded.summary,tags=excluded.tags,normalized=excluded.normalized,provider=excluded.provider,model_version=excluded.model_version,prompt_version=excluded.prompt_version', [result.id, result.runId, result.assetId, result.shotId, result.summary, JSON.stringify(result.tags), JSON.stringify({ objects: result.objects || [], actions: result.actions || [], location: result.location ?? null, shotType: result.shotType ?? null, cameraMotion: result.cameraMotion ?? null, peopleCount: result.peopleCount ?? null, qualitySignals: result.qualitySignals || {} }), result.provider, result.modelVersion, result.promptVersion]);
          if (capability(run.capabilities, 'EMBEDDING')) await this.persistEmbedding(run, 'VISION', result.id, `${result.summary} ${(result.tags || []).map((tag) => tag.tag).join(' ')}`, this.providers.embedding, result.shotId, signal);
        }
      }
      if (capability(run.capabilities, 'EMBEDDING')) await this.persistEmbedding(run, 'ASSET', run.assetId, `${run.assetId} ${typeof metadata.originalName === 'string' ? metadata.originalName : ''}`.trim() || run.assetId, this.providers.embedding, null, signal);
      const finished = await this.db.query('update media_analysis_runs set status=$2, finished_at=now(), error=null where id=$1 returning *', [runId, 'SUCCEEDED']);
      return mapRun(finished.rows[0] as Record<string, unknown>);
    } catch (error) {
      const cancelled = Boolean(signal?.aborted) || (error as { code?: string })?.code === 'ABORT_ERR';
      await this.db.query('update media_analysis_runs set status=$2, error=$3, finished_at=now() where id=$1', [runId, cancelled ? 'CANCELLED' : 'FAILED', errorValue(error)]).catch(() => undefined);
      throw error;
    }
  }

  private async generateKeyframes(run: MediaAnalysisRunV1, shots: MediaAnalysisShotV1[], source: string | undefined, signal?: AbortSignal): Promise<void> {
    if (!source) throw Object.assign(new Error('MEDIA_ANALYSIS_SOURCE_PATH_REQUIRED'), { code: 'MEDIA_ANALYSIS_SOURCE_PATH_REQUIRED', retryable: false });
    const root = resolve(this.options.keyframeRoot || join(this.options.storage?.root || 'storage', 'intelligence-keyframes'));
    for (const shot of shots) {
      signal?.throwIfAborted();
      const storageKey = `intelligence/keyframes/${run.id}/${shot.id}.jpg`;
      const outputPath = containedPath(root, join(run.id, `${shot.id}.jpg`));
      const keyframe: MediaAnalysisKeyframeV1 = { id: `keyframe-${shot.id}`, runId: run.id, assetId: run.assetId, shotId: shot.id, timestampMs: Math.floor((shot.sourceInMs + shot.sourceOutMs) / 2), storageKey, frameHash: `${run.assetId}:${shot.id}:${shot.sourceInMs}:${shot.sourceOutMs}`, status: 'REFERENCED' };
      await this.db.query('insert into media_analysis_keyframes (id,run_id,asset_id,shot_id,timestamp_ms,storage_key,frame_hash,status,error) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (id) do update set timestamp_ms=excluded.timestamp_ms,storage_key=excluded.storage_key,frame_hash=excluded.frame_hash,error=null', [keyframe.id, keyframe.runId, keyframe.assetId, keyframe.shotId, keyframe.timestampMs, keyframe.storageKey, keyframe.frameHash, keyframe.status, null]);
      try {
        if (!await access(outputPath).then(() => true).catch(() => false)) await generateShotKeyframe(source, outputPath, shot.sourceInMs, shot.sourceOutMs, this.options.ffmpegPath || 'ffmpeg', signal);
        const bytes = await readFile(outputPath);
        const ready: MediaAnalysisKeyframeV1 = { ...keyframe, frameHash: createHash('sha256').update(bytes).digest('hex'), status: 'READY' };
        validateMediaAnalysisKeyframeV1(ready);
        await this.db.query("update media_analysis_keyframes set frame_hash=$2,status='READY',error=null where id=$1", [ready.id, ready.frameHash]);
      } catch (error) {
        await this.db.query("update media_analysis_keyframes set status='FAILED',error=$2 where id=$1", [keyframe.id, errorValue(error)]).catch(() => undefined);
        throw error;
      }
    }
  }

  private async persistEmbedding(run: MediaAnalysisRunV1, contentType: MediaAnalysisEmbeddingV1['contentType'], contentId: string, textSnapshot: string, provider: IntelligenceProviders['embedding'], shotId: string | null | undefined, signal?: AbortSignal): Promise<void> {
    const embedding = await provider.embed({ text: textSnapshot, modelVersion: this.options.embeddingModelVersion || (this.providers.mode === 'FAKE' ? 'fake-1' : 'configured'), ...(signal ? { signal } : {}) });
    const dimensions = embedding.vector.length;
    const existing = await this.db.query<{ dimensions: number }>('select dimensions from media_analysis_embeddings where run_id=$1 and dimensions is not null limit 1', [run.id]);
    if (existing.rows[0] && Number(existing.rows[0].dimensions) !== dimensions) throw Object.assign(new Error('EMBEDDING_DIMENSION_MISMATCH'), { code: 'EMBEDDING_DIMENSION_MISMATCH', retryable: false });
    const value: MediaAnalysisEmbeddingV1 = { id: `embedding-${run.id}-${contentType}-${contentId}`, runId: run.id, assetId: run.assetId, contentType, contentId, shotId: shotId || null, textSnapshot, vector: embedding.vector, dimensions, provider: embedding.provider, modelVersion: embedding.modelVersion, inputDigest: createHash('sha256').update(textSnapshot).digest('hex') };
    validateMediaAnalysisEmbeddingV1(value);
    await this.db.query('insert into media_analysis_embeddings (id,run_id,asset_id,content_type,content_id,shot_id,text_snapshot,vector,dimensions,provider,model_version,input_digest) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (run_id,content_type,content_id) do update set shot_id=excluded.shot_id,text_snapshot=excluded.text_snapshot,vector=excluded.vector,dimensions=excluded.dimensions,provider=excluded.provider,model_version=excluded.model_version,input_digest=excluded.input_digest', [value.id, value.runId, value.assetId, value.contentType, value.contentId, value.shotId, value.textSnapshot, JSON.stringify(value.vector), value.dimensions, value.provider, value.modelVersion, value.inputDigest]);
  }

  async search(projectId: string, query: string, limit = 20): Promise<MediaAnalysisSearchResultV1[]> {
    const boundedLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
    const trimmed = query.trim();
    const queryEmbedding = trimmed ? await this.providers.embedding.embed({ text: trimmed, modelVersion: this.options.embeddingModelVersion || (this.providers.mode === 'FAKE' ? 'fake-1' : 'configured') }) : null;
    const rows = await this.db.query('select v.asset_id,v.shot_id,v.summary,v.tags,v.normalized,s.source_in_ms,s.source_out_ms,e.vector,e.dimensions from media_analysis_vision_results v join media_analysis_runs r on r.id=v.run_id and r.project_id=$1 and r.status=$2 join assets a on a.id=v.asset_id and (r.source_checksum is null or r.source_checksum=a.checksum) join media_analysis_shots s on s.id=v.shot_id left join media_analysis_embeddings e on e.run_id=v.run_id and e.content_type=$3 and e.content_id=v.id order by v.id', [projectId, 'SUCCEEDED', 'VISION']);
    const queryTokens = semanticTokens(trimmed);
    return rows.rows.map((row) => {
      const tags = jsonArray(row.tags).map((item) => item && typeof item === 'object' && 'tag' in item ? String((item as { tag: unknown }).tag) : '').filter(Boolean);
      const text = `${String(row.summary)} ${tags.join(' ')}`;
      const matched = [...queryTokens].filter((term) => semanticTokens(text).has(term));
      const lexicalScore = queryTokens.size ? matched.length / queryTokens.size : 0;
      const vector = jsonArray(row.vector).map(Number);
      const semanticScore = queryEmbedding && vector.length === queryEmbedding.vector.length ? cosineSimilarity(queryEmbedding.vector, vector) : 0;
      const score = hybridSemanticScore({ lexicalScore, semanticScore, ...(this.options.semanticWeight === undefined ? {} : { semanticWeight: this.options.semanticWeight }), ...(this.options.lexicalWeight === undefined ? {} : { lexicalWeight: this.options.lexicalWeight }) });
      return { assetId: String(row.asset_id), shotId: String(row.shot_id), sourceInMs: Number(row.source_in_ms), sourceOutMs: Number(row.source_out_ms), score, semanticScore, lexicalScore, matchingQueries: matched.length ? [query] : [], summary: String(row.summary), tags };
    }).filter((row) => !trimmed || row.score > 0).sort((a, b) => b.score - a.score || a.assetId.localeCompare(b.assetId) || a.shotId.localeCompare(b.shotId)).slice(0, boundedLimit);
  }

  async results(projectId: string, runId: string): Promise<{ run: MediaAnalysisRunV1; technical: TechnicalMediaAnalysisV1 | null; shots: MediaAnalysisShotV1[]; keyframes: MediaAnalysisKeyframeV1[]; asr: MediaAnalysisAsrSegmentV1[]; vision: MediaAnalysisVisionResultV1[] }> {
    const run = await this.getRun(projectId, runId); if (!run) throw new Error('MEDIA_ANALYSIS_RUN_NOT_FOUND');
    const technicalRows = await this.db.query('select * from media_analysis_technical where run_id=$1', [runId]);
    const technical = technicalRows.rows[0] ? { runId, assetId: run.assetId, durationMs: Number(technicalRows.rows[0].duration_ms), width: Number(technicalRows.rows[0].width), height: Number(technicalRows.rows[0].height), fps: technicalRows.rows[0].fps === null ? null : Number(technicalRows.rows[0].fps), format: technicalRows.rows[0].format ? String(technicalRows.rows[0].format) : null, videoCodec: technicalRows.rows[0].video_codec ? String(technicalRows.rows[0].video_codec) : null, audioCodec: technicalRows.rows[0].audio_codec ? String(technicalRows.rows[0].audio_codec) : null, hasAudio: Boolean(technicalRows.rows[0].has_audio), provider: String(technicalRows.rows[0].provider), modelVersion: String(technicalRows.rows[0].model_version) } : null;
    const shots = (await this.db.query('select * from media_analysis_shots where run_id=$1 order by shot_index', [runId])).rows.map((row) => ({ id: String(row.id), runId, assetId: run.assetId, shotIndex: Number(row.shot_index), sourceInMs: Number(row.source_in_ms), sourceOutMs: Number(row.source_out_ms), confidence: Number(row.confidence), detectionVersion: String(row.detection_version) }));
    const keyframes = (await this.db.query('select * from media_analysis_keyframes where run_id=$1 order by shot_id', [runId])).rows.map((row) => ({ id: String(row.id), runId, assetId: run.assetId, shotId: String(row.shot_id), timestampMs: Number(row.timestamp_ms), storageKey: String(row.storage_key), frameHash: String(row.frame_hash), status: String(row.status) as MediaAnalysisKeyframeV1['status'] }));
    const asr = (await this.db.query('select * from media_analysis_asr_segments where run_id=$1 order by start_ms,segment_index', [runId])).rows.map((row) => ({ id: String(row.id), runId, assetId: run.assetId, segmentIndex: Number(row.segment_index), startMs: Number(row.start_ms), endMs: Number(row.end_ms), text: String(row.text), speaker: row.speaker ? String(row.speaker) : null, confidence: Number(row.confidence), provider: String(row.provider), modelVersion: String(row.model_version) }));
    const vision = (await this.db.query('select * from media_analysis_vision_results where run_id=$1 order by id', [runId])).rows.map((row) => { const normalized = row.normalized && typeof row.normalized === 'object' ? row.normalized as Record<string, unknown> : {}; return { id: String(row.id), runId, assetId: run.assetId, shotId: row.shot_id ? String(row.shot_id) : null, summary: String(row.summary), tags: jsonArray(row.tags) as MediaAnalysisVisionResultV1['tags'], objects: Array.isArray(normalized.objects) ? normalized.objects.map(String) : [], actions: Array.isArray(normalized.actions) ? normalized.actions.map(String) : [], location: typeof normalized.location === 'string' ? normalized.location : null, shotType: typeof normalized.shotType === 'string' ? normalized.shotType : null, cameraMotion: typeof normalized.cameraMotion === 'string' ? normalized.cameraMotion : null, peopleCount: typeof normalized.peopleCount === 'number' ? normalized.peopleCount : null, qualitySignals: normalized.qualitySignals && typeof normalized.qualitySignals === 'object' ? normalized.qualitySignals as Record<string, number | string | boolean> : {}, provider: String(row.provider), modelVersion: String(row.model_version), promptVersion: String(row.prompt_version) }; }) as MediaAnalysisVisionResultV1[];
    return { run, technical, shots, keyframes, asr, vision };
  }
}
