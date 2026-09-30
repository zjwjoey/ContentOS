import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { LocalStorageProvider } from '../../../infrastructure/storage/src/index.js';
import { FakeEmbeddingProvider, type EmbeddingProvider } from './providers.js';
import type { JobQueryExecutor } from '../../job/src/index.js';
import { validateEditManifest, type EditManifestV0, type IntelligentEditPlanV1, type IntelligentPlannerConfigV1 } from '../../../contracts/src/index.js';
import { evaluateIntelligentManifest, planIntelligentEdit, type IntelligentPlannerSentence, type IntelligentPlannerShot } from './intelligent-planner.js';
import type { VideoService } from '../../video/src/index.js';

export interface CreateIntelligentPlanInput { id?: string; projectId: string; assetIds: string[]; sentences: IntelligentPlannerSentence[]; config: IntelligentPlannerConfigV1; seed?: number; }
export interface ApplyCandidateReplacementInput { projectId: string; planId: string; sentenceId: string; candidateId: string; }
export interface CandidateSelectionResult { planId: string; revision: number; manifestId: string; manifestRevision: number; renderJobId: string; selectedCandidateId: string; decisionEventId: string; manifest: EditManifestV0; quality: IntelligentEditPlanV1['quality']; }
export interface IntelligentPlanningServiceOptions { storage?: LocalStorageProvider; embeddingProvider?: EmbeddingProvider; video?: VideoService; analysisVersion?: string; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function tags(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((item) => item && typeof item === 'object' && typeof (item as { tag?: unknown }).tag === 'string' ? [String((item as { tag: string }).tag)] : typeof item === 'string' ? [item] : []) : []; }
function sourcePath(storage: LocalStorageProvider | undefined, key: string): string { return storage ? storage.objectPath(key) : key; }
function vector(value: unknown): number[] | undefined { const parsed = Array.isArray(value) ? value.map(Number) : []; return parsed.length && parsed.every(Number.isFinite) ? parsed : undefined; }
const candidateReplacementInFlight = new Set<string>();

export class IntelligentPlanningService {
  private readonly embeddingProvider: EmbeddingProvider;
  constructor(private readonly db: Pool, private readonly options: IntelligentPlanningServiceOptions = {}) { this.embeddingProvider = options.embeddingProvider || new FakeEmbeddingProvider(); }

  async createPlan(input: CreateIntelligentPlanInput): Promise<IntelligentEditPlanV1> {
    const uniqueAssetIds = [...new Set(input.assetIds)];
    if (!uniqueAssetIds.length) throw new Error('INTELLIGENT_PLANNER_ASSET_NOT_FOUND');
    const shots: IntelligentPlannerShot[] = []; const sourceRuns = new Set<string>();
    for (const assetId of uniqueAssetIds) {
      const asset = await this.db.query('select a.id,a.storage_key,a.metadata,a.checksum from assets a left join project_assets pa on pa.asset_id=a.id and pa.project_id=$1 where a.id=$2 and a.kind=\'VIDEO\' and a.lifecycle=\'READY\' and (a.project_id=$1 or pa.project_id=$1)', [input.projectId, assetId]);
      const row = asset.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new Error('INTELLIGENT_PLANNER_ASSET_NOT_FOUND');
      const analysis = await this.db.query(`select s.id as shot_id,s.source_in_ms,s.source_out_ms,s.confidence,s.detection_version,r.id as run_id,a.storage_key,a.metadata,v.summary,v.tags,v.normalized,e.vector
        from media_analysis_shots s join (select distinct on (asset_id) id,project_id,asset_id,status,source_checksum,created_at from media_analysis_runs where project_id=$1 and asset_id=$2 and status='SUCCEEDED' order by asset_id,created_at desc,id desc) r on r.id=s.run_id
        join assets a on a.id=r.asset_id and (r.source_checksum is null or r.source_checksum=a.checksum)
        left join media_analysis_vision_results v on v.run_id=r.id and v.shot_id=s.id
        left join media_analysis_embeddings e on e.run_id=r.id and e.content_type='VISION' and e.content_id=v.id
        where s.asset_id=$2 order by r.created_at desc,s.shot_index`, [input.projectId, assetId]);
      if (!analysis.rows.length) throw new Error('INTELLIGENT_PLANNER_SHOTS_NOT_READY');
      for (const shotRow of analysis.rows as Array<Record<string, unknown>>) {
        const normalized = record(shotRow.normalized); const runId = String(shotRow.run_id); sourceRuns.add(runId);
        const start = Number(shotRow.source_in_ms); const end = Number(shotRow.source_out_ms);
        const transcript = (await this.db.query('select coalesce(string_agg(text, \' \' order by start_ms,segment_index),\'\') as transcript from media_analysis_asr_segments where run_id=$1 and start_ms < $3 and end_ms > $2', [runId, start, end])).rows[0]?.transcript;
        const shotVector = vector(shotRow.vector);
        shots.push({ id: `${assetId}:${String(shotRow.shot_id)}`, assetId: String(row.id), shotId: String(shotRow.shot_id), sourcePath: sourcePath(this.options.storage, String(shotRow.storage_key)), sourceInMs: start, sourceOutMs: end, durationMs: end - start, summary: shotRow.summary ? String(shotRow.summary) : '', tags: tags(shotRow.tags), transcript: transcript ? String(transcript) : '', qualityScore: typeof normalized.qualityScore === 'number' ? normalized.qualityScore : Number(shotRow.confidence || 0.5), ...(typeof normalized.shotType === 'string' ? { shotType: normalized.shotType } : {}), ...(typeof normalized.cameraMotion === 'string' ? { cameraMotion: normalized.cameraMotion } : {}), ...(shotVector ? { embedding: shotVector } : {}) });
      }
    }
    const sentenceEmbeddings = await Promise.all(input.sentences.map((sentence) => this.embeddingProvider.embed({ text: sentence.text, modelVersion: 'planner-query-v1' })));
    const sentences = input.sentences.map((sentence, index) => ({ ...sentence, ...(sentenceEmbeddings[index]?.vector ? { embedding: sentenceEmbeddings[index]!.vector } : {}) }));
    const plan = planIntelligentEdit({ id: input.id || `intelligent-plan-${randomUUID()}`, projectId: input.projectId, ...(input.seed === undefined ? {} : { seed: input.seed }), sentences, shots, config: input.config, sourceAnalysisRunIds: [...sourceRuns], analysisVersion: this.options.analysisVersion || 'intelligent-editing-v15-core-closure-1' });
    const manifestRecord = await this.withTransaction(async (executor) => {
      let manifestId: string | null = null; let renderJobId: string | null = null;
      if (this.options.video) {
        const persistedManifest = await this.options.video.createManifestRevisionWithExecutor(executor, input.projectId, plan.manifest, { createdBy: 'intelligent-planner-v1', idempotencyKey: `intelligent-plan:${plan.id}` });
        manifestId = persistedManifest.manifestId;
        renderJobId = (await this.options.video.createManifestRenderJobWithExecutor(executor, input.projectId, manifestId)).id;
      }
      await executor.query('insert into intelligent_edit_plans (id,project_id,status,config,source_analysis_run_ids,manifest,quality,manifest_id,video_revision_id,render_job_id,planner_version,analysis_version,revision) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [plan.id, plan.projectId, 'READY', JSON.stringify(plan.config), JSON.stringify([...sourceRuns]), JSON.stringify(plan.manifest), JSON.stringify(plan.quality), manifestId, manifestId, renderJobId, plan.plannerVersion || input.config.version, plan.analysisVersion || null, 1]);
      for (const candidate of plan.candidates) await executor.query('insert into intelligent_edit_candidates (id,plan_id,sentence_id,asset_id,shot_id,source_in_ms,source_out_ms,score,selected,reasons,features) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [candidate.id, plan.id, candidate.sentenceId, candidate.assetId, candidate.shotId, candidate.sourceInMs ?? null, candidate.sourceOutMs ?? null, candidate.score, candidate.selected, JSON.stringify(candidate.reasons), JSON.stringify(candidate.features)]);
      await executor.query('insert into intelligent_edit_evaluations (id,plan_id,evaluator_version,quality) values ($1,$2,$3,$4)', [`evaluation-${plan.id}`, plan.id, 'intelligent-evaluator-v2-shot-level', JSON.stringify(plan.quality)]);
      return { manifestId, renderJobId };
    });
    const { manifestId, renderJobId } = manifestRecord;
    return { ...plan, manifestId, videoRevisionId: manifestId, renderJobId, revision: 1 };
  }

  async applyCandidateReplacement(input: ApplyCandidateReplacementInput): Promise<CandidateSelectionResult> {
    if (!this.options.video) throw new Error('INTELLIGENT_REPLACEMENT_VIDEO_SERVICE_REQUIRED');
    const inFlightKey = `${input.projectId}:${input.planId}:${input.sentenceId}`;
    if (candidateReplacementInFlight.has(inFlightKey)) throw new Error('INTELLIGENT_CANDIDATE_SELECTION_CONFLICT');
    candidateReplacementInFlight.add(inFlightKey);
    try {
      const client = await this.db.connect();
      try {
        await client.query('begin');
        const lockResult = await client.query<{ locked: boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) as locked', [`contentos:intelligent-candidate-replacement:${input.planId}:${input.sentenceId}`]);
        if (!lockResult.rows[0]?.locked) throw new Error('INTELLIGENT_CANDIDATE_SELECTION_CONFLICT');
        const planResult = await client.query<Record<string, unknown>>('select * from intelligent_edit_plans where id=$1 and project_id=$2 for update', [input.planId, input.projectId]);
        const plan = planResult.rows[0];
        if (!plan) throw new Error('INTELLIGENT_PLAN_NOT_FOUND');
        const candidateResult = await client.query<Record<string, unknown>>('select * from intelligent_edit_candidates where plan_id=$1 and sentence_id=$2 order by selected desc, score desc, id for update', [input.planId, input.sentenceId]);
        const candidates = candidateResult.rows;
        const previous = candidates.find((candidate) => Boolean(candidate.selected));
        const next = candidates.find((candidate) => String(candidate.id) === input.candidateId);
        if (!previous || !next) throw new Error('INTELLIGENT_CANDIDATE_NOT_FOUND');
        if (String(next.sentence_id) !== input.sentenceId) throw new Error('INTELLIGENT_CANDIDATE_SENTENCE_MISMATCH');
        if (String(previous.id) === String(next.id)) throw new Error('INTELLIGENT_CANDIDATE_ALREADY_SELECTED');
        if (Boolean(next.selected)) throw new Error('INTELLIGENT_CANDIDATE_ALREADY_SELECTED');
      const manifest = structuredClone(plan.manifest as EditManifestV0);
      const timelineIndex = manifest.timeline.findIndex((clip) => clip.sentenceId === input.sentenceId);
      if (timelineIndex < 0) throw new Error('INTELLIGENT_SENTENCE_NOT_IN_MANIFEST');
      const currentClip = manifest.timeline[timelineIndex]!;
      const source = await client.query<{ storage_key: string; metadata: Record<string, unknown> }>('select a.storage_key,a.metadata from assets a left join project_assets pa on pa.asset_id=a.id and pa.project_id=$1 where a.id=$2 and a.kind=\'VIDEO\' and a.lifecycle=\'READY\' and (a.project_id=$1 or pa.project_id=$1)', [input.projectId, next.asset_id]);
      if (!source.rows[0]) throw new Error('INTELLIGENT_CANDIDATE_ASSET_NOT_FOUND');
      const sourceInMs = Number(next.source_in_ms ?? currentClip.sourceInMs);
      const candidateEndMs = Number(next.source_out_ms ?? (sourceInMs + currentClip.durationMs));
      const durationMs = Math.min(currentClip.durationMs, candidateEndMs - sourceInMs);
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('INTELLIGENT_CANDIDATE_SOURCE_RANGE_INVALID');
      const shot = next.shot_id ? await client.query<{ normalized: Record<string, unknown> }>('select normalized from media_analysis_vision_results where shot_id=$1 order by id desc limit 1', [next.shot_id]) : { rows: [] };
      const normalized = record(shot.rows[0]?.normalized);
      const shotType = typeof normalized.shotType === 'string' && normalized.shotType.trim() ? normalized.shotType : (currentClip.matching?.shotType || 'unknown');
      const cameraMotion = typeof normalized.cameraMotion === 'string' && normalized.cameraMotion.trim() ? normalized.cameraMotion : currentClip.matching?.cameraMotion;
      const matching = { ...(currentClip.matching || { matchedKeywords: [], matchScore: 0, fallback: true, matchingReason: 'manual candidate replacement' }), shotType, ...(next.shot_id ? { sourceSegmentId: String(next.shot_id) } : {}), ...(cameraMotion ? { cameraMotion } : {}), selectedRole: shotType === 'unknown' ? 'GENERIC_BROLL' as const : 'AUTHENTIC_ENTITY' as const, ...(String(next.asset_id) === String(previous.asset_id) ? { allowAssetReuse: true } : {}) };
      manifest.timeline[timelineIndex] = { ...currentClip, assetId: String(next.asset_id), sourcePath: sourcePath(this.options.storage, String(source.rows[0].storage_key)), sourceInMs, sourceOutMs: sourceInMs + durationMs, durationMs, ...(next.shot_id ? { sourceSegmentId: String(next.shot_id) } : {}), matching, selectionSource: 'MANUAL', revision: Number(currentClip.revision || 1) + 1 };
      validateEditManifest(manifest);
      const quality = evaluateIntelligentManifest(manifest, plan.config as IntelligentPlannerConfigV1);
      const nextPlanRevision = Number(plan.revision || 1) + 1;
      const manifestRecord = await this.options.video.createManifestRevisionWithExecutor(client, input.projectId, manifest, { createdBy: 'intelligent-candidate-replacement', idempotencyKey: `intelligent-plan:${input.planId}:revision:${nextPlanRevision}:candidate:${input.candidateId}`, forceNewRevision: true });
      const renderJob = await this.options.video.createManifestRenderJobWithExecutor(client, input.projectId, manifestRecord.manifestId);
      const decisionEventId = `decision-${randomUUID()}`;
      await client.query('update intelligent_edit_candidates set selected=false where plan_id=$1 and sentence_id=$2', [input.planId, input.sentenceId]);
      await client.query('update intelligent_edit_candidates set selected=true where id=$1 and plan_id=$2 and sentence_id=$3', [input.candidateId, input.planId, input.sentenceId]);
      await client.query('update intelligent_edit_plans set manifest=$2,quality=$3,manifest_id=$4,video_revision_id=$4,render_job_id=$5,revision=$6,status=\'READY\' where id=$1 and project_id=$7', [input.planId, JSON.stringify(manifest), JSON.stringify(quality), manifestRecord.manifestId, renderJob.id, nextPlanRevision, input.projectId]);
      await client.query('insert into editing_decision_events (id,project_id,plan_id,sentence_id,event_type,previous_candidate_id,next_candidate_id,previous_shot_id,next_shot_id,evidence) values ($1,$2,$3,$4,\'SHOT_REPLACED\',$5,$6,$7,$8,$9)', [decisionEventId, input.projectId, input.planId, input.sentenceId, previous.id, next.id, previous.shot_id || null, next.shot_id || null, JSON.stringify({ source: 'IntelligentPlanningService', planRevision: nextPlanRevision, manifestRevision: manifestRecord.revision, candidateAssetId: next.asset_id })]);
        await client.query('commit');
        return { planId: input.planId, revision: nextPlanRevision, manifestId: manifestRecord.manifestId, manifestRevision: manifestRecord.revision, renderJobId: renderJob.id, selectedCandidateId: input.candidateId, decisionEventId, manifest, quality };
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    } finally { candidateReplacementInFlight.delete(inFlightKey); }
  }

  private async withTransaction<T>(action: (executor: JobQueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const result = await action(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }

  async getPlan(projectId: string, planId: string): Promise<IntelligentEditPlanV1 | null> {
    const plan = await this.db.query('select * from intelligent_edit_plans where project_id=$1 and id=$2', [projectId, planId]);
    const row = plan.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const candidates = await this.db.query('select * from intelligent_edit_candidates where plan_id=$1 order by sentence_id,score desc,id', [planId]);
    return { schemaVersion: 'INTELLIGENT_EDIT_PLAN_V1', id: String(row.id), projectId: String(row.project_id), config: row.config as IntelligentPlannerConfigV1, manifest: row.manifest as IntelligentEditPlanV1['manifest'], candidates: candidates.rows.map((candidate) => ({ id: String(candidate.id), sentenceId: String(candidate.sentence_id), assetId: String(candidate.asset_id), shotId: candidate.shot_id ? String(candidate.shot_id) : null, sourceInMs: candidate.source_in_ms === null ? null : Number(candidate.source_in_ms), sourceOutMs: candidate.source_out_ms === null ? null : Number(candidate.source_out_ms), score: Number(candidate.score), selected: Boolean(candidate.selected), reasons: Array.isArray(candidate.reasons) ? candidate.reasons.map(String) : [], features: record(candidate.features) as unknown as IntelligentEditPlanV1['candidates'][number]['features'] })), quality: row.quality as IntelligentEditPlanV1['quality'], sourceAnalysisRunIds: Array.isArray(row.source_analysis_run_ids) ? row.source_analysis_run_ids.map(String) : [], manifestId: row.manifest_id ? String(row.manifest_id) : null, videoRevisionId: row.video_revision_id ? String(row.video_revision_id) : null, renderJobId: row.render_job_id ? String(row.render_job_id) : null, revision: Number(row.revision || 1), ...(row.planner_version ? { plannerVersion: String(row.planner_version) } : {}), analysisVersion: row.analysis_version ? String(row.analysis_version) : null, createdAt: new Date(String(row.created_at)).toISOString() };
  }
}
