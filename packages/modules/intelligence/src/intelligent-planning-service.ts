import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { LocalStorageProvider } from '../../../infrastructure/storage/src/index.js';
import { FakeEmbeddingProvider, type EmbeddingProvider } from './providers.js';
import type { IntelligentEditPlanV1, IntelligentPlannerConfigV1 } from '../../../contracts/src/index.js';
import { planIntelligentEdit, type IntelligentPlannerSentence, type IntelligentPlannerShot } from './intelligent-planner.js';
import type { VideoService } from '../../video/src/index.js';

export interface CreateIntelligentPlanInput { id?: string; projectId: string; assetIds: string[]; sentences: IntelligentPlannerSentence[]; config: IntelligentPlannerConfigV1; seed?: number; }
export interface IntelligentPlanningServiceOptions { storage?: LocalStorageProvider; embeddingProvider?: EmbeddingProvider; video?: VideoService; analysisVersion?: string; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function tags(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((item) => item && typeof item === 'object' && typeof (item as { tag?: unknown }).tag === 'string' ? [String((item as { tag: string }).tag)] : typeof item === 'string' ? [item] : []) : []; }
function sourcePath(storage: LocalStorageProvider | undefined, key: string): string { return storage ? storage.objectPath(key) : key; }
function vector(value: unknown): number[] | undefined { const parsed = Array.isArray(value) ? value.map(Number) : []; return parsed.length && parsed.every(Number.isFinite) ? parsed : undefined; }

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
        from media_analysis_shots s join media_analysis_runs r on r.id=s.run_id and r.project_id=$1 and r.asset_id=$2 and r.status='SUCCEEDED'
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
    let manifestId: string | null = null; let renderJobId: string | null = null;
    if (this.options.video) {
      ({ manifestId } = await this.options.video.createManifestRevision(input.projectId, plan.manifest, { createdBy: 'intelligent-planner-v1', idempotencyKey: `intelligent-plan:${plan.id}` }));
      renderJobId = (await this.options.video.createManifestRenderJob(input.projectId, manifestId)).id;
    }
    await this.db.query('insert into intelligent_edit_plans (id,project_id,status,config,source_analysis_run_ids,manifest,quality,manifest_id,video_revision_id,render_job_id,planner_version,analysis_version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [plan.id, plan.projectId, 'READY', JSON.stringify(plan.config), JSON.stringify([...sourceRuns]), JSON.stringify(plan.manifest), JSON.stringify(plan.quality), manifestId, manifestId, renderJobId, plan.plannerVersion || input.config.version, plan.analysisVersion || null]);
    for (const candidate of plan.candidates) await this.db.query('insert into intelligent_edit_candidates (id,plan_id,sentence_id,asset_id,shot_id,source_in_ms,source_out_ms,score,selected,reasons,features) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [candidate.id, plan.id, candidate.sentenceId, candidate.assetId, candidate.shotId, candidate.sourceInMs ?? null, candidate.sourceOutMs ?? null, candidate.score, candidate.selected, JSON.stringify(candidate.reasons), JSON.stringify(candidate.features)]);
    await this.db.query('insert into intelligent_edit_evaluations (id,plan_id,evaluator_version,quality) values ($1,$2,$3,$4)', [`evaluation-${plan.id}`, plan.id, 'intelligent-evaluator-v2-shot-level', JSON.stringify(plan.quality)]);
    return { ...plan, manifestId, videoRevisionId: manifestId, renderJobId };
  }

  async getPlan(projectId: string, planId: string): Promise<IntelligentEditPlanV1 | null> {
    const plan = await this.db.query('select * from intelligent_edit_plans where project_id=$1 and id=$2', [projectId, planId]);
    const row = plan.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const candidates = await this.db.query('select * from intelligent_edit_candidates where plan_id=$1 order by sentence_id,score desc,id', [planId]);
    return { schemaVersion: 'INTELLIGENT_EDIT_PLAN_V1', id: String(row.id), projectId: String(row.project_id), config: row.config as IntelligentPlannerConfigV1, manifest: row.manifest as IntelligentEditPlanV1['manifest'], candidates: candidates.rows.map((candidate) => ({ id: String(candidate.id), sentenceId: String(candidate.sentence_id), assetId: String(candidate.asset_id), shotId: candidate.shot_id ? String(candidate.shot_id) : null, sourceInMs: candidate.source_in_ms === null ? null : Number(candidate.source_in_ms), sourceOutMs: candidate.source_out_ms === null ? null : Number(candidate.source_out_ms), score: Number(candidate.score), selected: Boolean(candidate.selected), reasons: Array.isArray(candidate.reasons) ? candidate.reasons.map(String) : [], features: record(candidate.features) as unknown as IntelligentEditPlanV1['candidates'][number]['features'] })), quality: row.quality as IntelligentEditPlanV1['quality'], sourceAnalysisRunIds: Array.isArray(row.source_analysis_run_ids) ? row.source_analysis_run_ids.map(String) : [], manifestId: row.manifest_id ? String(row.manifest_id) : null, videoRevisionId: row.video_revision_id ? String(row.video_revision_id) : null, renderJobId: row.render_job_id ? String(row.render_job_id) : null, ...(row.planner_version ? { plannerVersion: String(row.planner_version) } : {}), analysisVersion: row.analysis_version ? String(row.analysis_version) : null, createdAt: new Date(String(row.created_at)).toISOString() };
  }
}
