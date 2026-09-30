import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  INTELLIGENT_EDITING_V15_ANALYSIS_VERSION,
  INTELLIGENT_EDITING_V15_RUN_SCHEMA,
  validateMediaAnalysisAsrSegmentV1,
  validateMediaAnalysisRunV1,
  validateMediaAnalysisShotV1,
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
import type { IntelligenceProviders } from './providers.js';

export const MEDIA_ANALYSIS = 'MEDIA_ANALYSIS' as const;
export interface CreateMediaAnalysisInput { id?: string; projectId: string; assetId: string; capabilities?: MediaAnalysisCapability[]; providerMode?: 'FAKE' | 'REAL'; idempotencyKey?: string; }
export interface MediaIntelligenceServiceOptions { analysisVersion?: string; }

const DEFAULT_CAPABILITIES: MediaAnalysisCapability[] = ['TECHNICAL', 'SHOTS', 'KEYFRAMES', 'ASR', 'VISION', 'EMBEDDING'];
type AssetRow = { id: string; metadata: Record<string, unknown>; storage_key: string };

function mapRun(row: Record<string, unknown>): MediaAnalysisRunV1 {
  const value: MediaAnalysisRunV1 = {
    schemaVersion: INTELLIGENT_EDITING_V15_RUN_SCHEMA,
    id: String(row.id), projectId: String(row.project_id), assetId: String(row.asset_id), status: String(row.status) as MediaAnalysisRunV1['status'],
    capabilities: (Array.isArray(row.capabilities) ? row.capabilities : []) as MediaAnalysisCapability[], providerMode: String(row.provider_mode) as MediaAnalysisRunV1['providerMode'],
    analysisVersion: String(row.analysis_version), idempotencyKey: String(row.idempotency_key), jobId: row.job_id ? String(row.job_id) : null, attemptCount: Number(row.attempt_count),
    error: row.error && typeof row.error === 'object' ? row.error as MediaAnalysisRunV1['error'] : null,
    createdAt: new Date(String(row.created_at)).toISOString(), startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null, finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
  };
  validateMediaAnalysisRunV1(value);
  return value;
}

function capability(input: MediaAnalysisCapability[], name: MediaAnalysisCapability): boolean { return input.includes(name); }
function safeMetadata(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function errorValue(error: unknown): { code: string; message: string } { const candidate = error as { code?: unknown }; return { code: typeof candidate?.code === 'string' ? candidate.code : 'MEDIA_ANALYSIS_FAILED', message: error instanceof Error ? error.message : 'Media analysis failed' }; }

export class MediaIntelligenceService {
  constructor(private readonly db: Pool, private readonly providers: IntelligenceProviders, private readonly options: MediaIntelligenceServiceOptions = {}) {}

  async createRun(input: CreateMediaAnalysisInput): Promise<MediaAnalysisRunV1> {
    const capabilities = [...new Set(input.capabilities?.length ? input.capabilities : DEFAULT_CAPABILITIES)];
    const asset = await this.db.query<AssetRow>('select a.id, a.metadata, a.storage_key from assets a left join project_assets pa on pa.asset_id = a.id and pa.project_id = $1 where a.id = $2 and a.lifecycle = $3 and (a.project_id = $1 or pa.project_id = $1)', [input.projectId, input.assetId, 'READY']);
    if (!asset.rows[0]) throw new Error('MEDIA_ANALYSIS_ASSET_NOT_FOUND');
    const idempotencyKey = input.idempotencyKey?.trim() || `media-analysis:${input.projectId}:${input.assetId}:${this.options.analysisVersion || INTELLIGENT_EDITING_V15_ANALYSIS_VERSION}:${capabilities.join(',')}`;
    const result = await this.db.query('insert into media_analysis_runs (id, project_id, asset_id, status, capabilities, provider_mode, analysis_version, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (project_id,idempotency_key) do nothing returning *', [input.id || `analysis-${randomUUID()}`, input.projectId, input.assetId, 'QUEUED', capabilities, input.providerMode || this.providers.mode, this.options.analysisVersion || INTELLIGENT_EDITING_V15_ANALYSIS_VERSION, idempotencyKey]);
    if (result.rows[0]) return mapRun(result.rows[0] as Record<string, unknown>);
    const existing = await this.db.query('select * from media_analysis_runs where project_id = $1 and idempotency_key = $2', [input.projectId, idempotencyKey]);
    if (!existing.rows[0]) throw new Error('MEDIA_ANALYSIS_IDEMPOTENCY_CONFLICT');
    return mapRun(existing.rows[0] as Record<string, unknown>);
  }

  async attachJob(runId: string, jobId: string): Promise<void> { await this.db.query('update media_analysis_runs set job_id = $2 where id = $1', [runId, jobId]); }
  async getRun(projectId: string, runId: string): Promise<MediaAnalysisRunV1 | null> { const result = await this.db.query('select * from media_analysis_runs where project_id = $1 and id = $2', [projectId, runId]); return result.rows[0] ? mapRun(result.rows[0] as Record<string, unknown>) : null; }

  async analyzeRun(runId: string, signal?: AbortSignal): Promise<MediaAnalysisRunV1> {
    const selected = await this.db.query('select r.*, a.metadata, a.storage_key from media_analysis_runs r join assets a on a.id = r.asset_id where r.id = $1', [runId]);
    const row = selected.rows[0] as (Record<string, unknown> & { metadata?: unknown; storage_key?: unknown }) | undefined;
    if (!row) throw new Error('MEDIA_ANALYSIS_RUN_NOT_FOUND');
    if (row.status === 'SUCCEEDED') return mapRun(row);
    const run = mapRun(row);
    await this.db.query("update media_analysis_runs set status='RUNNING', started_at=coalesce(started_at,now()), attempt_count=attempt_count+1, error=null where id=$1", [runId]);
    try {
      const metadata = safeMetadata(row.metadata);
      const technicalBase = await this.providers.technical.probe({ assetId: run.assetId, runId, metadata });
      const technical: TechnicalMediaAnalysisV1 = { runId, assetId: run.assetId, ...technicalBase };
      validateTechnicalMediaAnalysisV1(technical);
      await this.db.query('insert into media_analysis_technical (run_id,asset_id,duration_ms,width,height,fps,format,video_codec,audio_codec,has_audio,provider,model_version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (run_id) do update set duration_ms=excluded.duration_ms,width=excluded.width,height=excluded.height,fps=excluded.fps,format=excluded.format,video_codec=excluded.video_codec,audio_codec=excluded.audio_codec,has_audio=excluded.has_audio,provider=excluded.provider,model_version=excluded.model_version', [runId, run.assetId, technical.durationMs, technical.width, technical.height, technical.fps, technical.format, technical.videoCodec, technical.audioCodec, technical.hasAudio, technical.provider, technical.modelVersion]);
      const shotCount = Math.max(1, Math.ceil(technical.durationMs / 5_000));
      const shots: MediaAnalysisShotV1[] = Array.from({ length: shotCount }, (_, index) => ({ id: `shot-${runId}-${index}`, runId, assetId: run.assetId, shotIndex: index, sourceInMs: Math.floor(index * technical.durationMs / shotCount), sourceOutMs: Math.max(1, Math.floor((index + 1) * technical.durationMs / shotCount)), confidence: 0.5, detectionVersion: 'foundation-uniform-v1' }));
      for (const shot of shots) { validateMediaAnalysisShotV1(shot); await this.db.query('insert into media_analysis_shots (id,run_id,asset_id,shot_index,source_in_ms,source_out_ms,confidence,detection_version) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing', [shot.id, shot.runId, shot.assetId, shot.shotIndex, shot.sourceInMs, shot.sourceOutMs, shot.confidence, shot.detectionVersion]); }
      if (capability(run.capabilities, 'KEYFRAMES')) for (const shot of shots) { const keyframe: MediaAnalysisKeyframeV1 = { id: `keyframe-${shot.id}`, runId, assetId: run.assetId, shotId: shot.id, timestampMs: Math.floor((shot.sourceInMs + shot.sourceOutMs) / 2), storageKey: `intelligence/keyframes/${runId}/${shot.id}.jpg`, frameHash: `${run.assetId}:${shot.id}`, status: 'REFERENCED' }; await this.db.query('insert into media_analysis_keyframes (id,run_id,asset_id,shot_id,timestamp_ms,storage_key,frame_hash,status) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing', [keyframe.id, keyframe.runId, keyframe.assetId, keyframe.shotId, keyframe.timestampMs, keyframe.storageKey, keyframe.frameHash, keyframe.status]); }
      if (capability(run.capabilities, 'ASR')) for (const item of await this.providers.asr.transcribe({ assetId: run.assetId, runId, durationMs: technical.durationMs, metadata })) { signal?.throwIfAborted(); const segment: MediaAnalysisAsrSegmentV1 = { id: `asr-${runId}-${randomUUID()}`, runId, assetId: run.assetId, ...item }; validateMediaAnalysisAsrSegmentV1(segment); await this.db.query('insert into media_analysis_asr_segments (id,run_id,asset_id,start_ms,end_ms,text,speaker,confidence,provider,model_version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [segment.id, segment.runId, segment.assetId, segment.startMs, segment.endMs, segment.text, segment.speaker, segment.confidence, segment.provider, segment.modelVersion]); if (capability(run.capabilities, 'EMBEDDING')) { const embedding = await this.providers.embedding.embed({ text: segment.text, modelVersion: 'fake-1' }); await this.persistEmbedding(run, 'ASR', segment.id, segment.text, embedding); } }
      if (capability(run.capabilities, 'VISION')) for (const item of await this.providers.vision.analyze({ assetId: run.assetId, runId, shots, metadata })) { signal?.throwIfAborted(); const result: MediaAnalysisVisionResultV1 = { id: `vision-${runId}-${randomUUID()}`, runId, assetId: run.assetId, ...item }; await this.db.query('insert into media_analysis_vision_results (id,run_id,asset_id,shot_id,summary,tags,provider,model_version,prompt_version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [result.id, result.runId, result.assetId, result.shotId, result.summary, JSON.stringify(result.tags), result.provider, result.modelVersion, result.promptVersion]); if (capability(run.capabilities, 'EMBEDDING')) { const embedding = await this.providers.embedding.embed({ text: `${result.summary} ${result.tags.map((tag) => tag.tag).join(' ')}`, modelVersion: 'fake-1' }); await this.persistEmbedding(run, 'VISION', result.id, result.summary, embedding); } }
      if (capability(run.capabilities, 'EMBEDDING')) { const embedding = await this.providers.embedding.embed({ text: `${run.assetId} ${typeof metadata.originalName === 'string' ? metadata.originalName : ''}`, modelVersion: 'fake-1' }); await this.persistEmbedding(run, 'ASSET', run.assetId, String(metadata.originalName || run.assetId), embedding); }
      const finished = await this.db.query('update media_analysis_runs set status=$2, finished_at=now() where id=$1 returning *', [runId, 'SUCCEEDED']);
      return mapRun(finished.rows[0] as Record<string, unknown>);
    } catch (error) {
      await this.db.query('update media_analysis_runs set status=$2, error=$3, finished_at=now() where id=$1', [runId, signal?.aborted ? 'CANCELLED' : 'FAILED', errorValue(error)]);
      throw error;
    }
  }

  private async persistEmbedding(run: MediaAnalysisRunV1, contentType: MediaAnalysisEmbeddingV1['contentType'], contentId: string, textSnapshot: string, embedding: { vector: number[]; provider: string; modelVersion: string }): Promise<void> { await this.db.query('insert into media_analysis_embeddings (id,run_id,asset_id,content_type,content_id,text_snapshot,vector,dimensions,provider,model_version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (run_id,content_type,content_id) do update set text_snapshot=excluded.text_snapshot,vector=excluded.vector,dimensions=excluded.dimensions,provider=excluded.provider,model_version=excluded.model_version', [`embedding-${run.id}-${contentType}-${contentId}`, run.id, run.assetId, contentType, contentId, textSnapshot, JSON.stringify(embedding.vector), embedding.vector.length, embedding.provider, embedding.modelVersion]); }

  async search(projectId: string, query: string, limit = 20): Promise<MediaAnalysisSearchResultV1[]> {
    const result = await this.db.query('select v.asset_id, v.summary, v.tags, r.project_id from media_analysis_vision_results v join media_analysis_runs r on r.id=v.run_id where r.project_id=$1 and r.status=$2 order by v.id', [projectId, 'SUCCEEDED']);
    const terms = new Set(query.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    return result.rows.map((row) => { const tags = Array.isArray(row.tags) ? row.tags.map((item: unknown) => item && typeof item === 'object' && 'tag' in item ? String((item as { tag: unknown }).tag) : '').filter(Boolean) : []; const text = `${String(row.summary)} ${tags.join(' ')}`.toLowerCase(); const matchingQueries = [...terms].filter((term) => text.includes(term)); return { assetId: String(row.asset_id), score: terms.size ? matchingQueries.length / terms.size : 0, matchingQueries, summary: String(row.summary), tags }; }).filter((row) => !query.trim() || row.score > 0).sort((a, b) => b.score - a.score || a.assetId.localeCompare(b.assetId)).slice(0, Math.min(100, Math.max(1, limit)));
  }

  async results(projectId: string, runId: string): Promise<{ run: MediaAnalysisRunV1; technical: TechnicalMediaAnalysisV1 | null; shots: MediaAnalysisShotV1[]; asr: MediaAnalysisAsrSegmentV1[]; vision: MediaAnalysisVisionResultV1[] }> {
    const run = await this.getRun(projectId, runId); if (!run) throw new Error('MEDIA_ANALYSIS_RUN_NOT_FOUND');
    const technicalRows = await this.db.query('select * from media_analysis_technical where run_id=$1', [runId]);
    const technical = technicalRows.rows[0] ? { runId, assetId: run.assetId, durationMs: Number(technicalRows.rows[0].duration_ms), width: Number(technicalRows.rows[0].width), height: Number(technicalRows.rows[0].height), fps: technicalRows.rows[0].fps === null ? null : Number(technicalRows.rows[0].fps), format: technicalRows.rows[0].format ? String(technicalRows.rows[0].format) : null, videoCodec: technicalRows.rows[0].video_codec ? String(technicalRows.rows[0].video_codec) : null, audioCodec: technicalRows.rows[0].audio_codec ? String(technicalRows.rows[0].audio_codec) : null, hasAudio: Boolean(technicalRows.rows[0].has_audio), provider: String(technicalRows.rows[0].provider), modelVersion: String(technicalRows.rows[0].model_version) } : null;
    const shots = (await this.db.query('select * from media_analysis_shots where run_id=$1 order by shot_index', [runId])).rows.map((row) => ({ id: String(row.id), runId, assetId: run.assetId, shotIndex: Number(row.shot_index), sourceInMs: Number(row.source_in_ms), sourceOutMs: Number(row.source_out_ms), confidence: Number(row.confidence), detectionVersion: String(row.detection_version) }));
    const asr = (await this.db.query('select * from media_analysis_asr_segments where run_id=$1 order by start_ms', [runId])).rows.map((row) => ({ id: String(row.id), runId, assetId: run.assetId, startMs: Number(row.start_ms), endMs: Number(row.end_ms), text: String(row.text), speaker: row.speaker ? String(row.speaker) : null, confidence: Number(row.confidence), provider: String(row.provider), modelVersion: String(row.model_version) }));
    const vision = (await this.db.query('select * from media_analysis_vision_results where run_id=$1 order by id', [runId])).rows.map((row) => ({ id: String(row.id), runId, assetId: run.assetId, shotId: row.shot_id ? String(row.shot_id) : null, summary: String(row.summary), tags: Array.isArray(row.tags) ? row.tags : [], provider: String(row.provider), modelVersion: String(row.model_version), promptVersion: String(row.prompt_version) })) as MediaAnalysisVisionResultV1[];
    return { run, technical, shots, asr, vision };
  }
}
