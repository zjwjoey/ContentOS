import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { IntelligentEditPlanV1, IntelligentPlannerConfigV1 } from '../../../contracts/src/index.js';
import { planIntelligentEdit, type IntelligentPlannerSentence } from './intelligent-planner.js';

export interface CreateIntelligentPlanInput { id?: string; projectId: string; assetIds: string[]; sentences: IntelligentPlannerSentence[]; config: IntelligentPlannerConfigV1; seed?: number; }

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function tags(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((item) => item && typeof item === 'object' && typeof (item as { tag?: unknown }).tag === 'string' ? [String((item as { tag: string }).tag)] : typeof item === 'string' ? [item] : []) : []; }

export class IntelligentPlanningService {
  constructor(private readonly db: Pool) {}

  async createPlan(input: CreateIntelligentPlanInput): Promise<IntelligentEditPlanV1> {
    const uniqueAssetIds = [...new Set(input.assetIds)];
    const assets = [] as Array<{ id: string; sourcePath: string; durationMs: number; summary: string; tags: string[]; qualityScore: number }>;
    for (const assetId of uniqueAssetIds) {
      const asset = await this.db.query('select a.id,a.storage_key,a.metadata from assets a left join project_assets pa on pa.asset_id=a.id and pa.project_id=$1 where a.id=$2 and a.kind=\'VIDEO\' and a.lifecycle=\'READY\' and (a.project_id=$1 or pa.project_id=$1)', [input.projectId, assetId]);
      const row = asset.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new Error('INTELLIGENT_PLANNER_ASSET_NOT_FOUND');
      const latest = await this.db.query('select t.duration_ms from media_analysis_technical t join media_analysis_runs r on r.id=t.run_id where r.project_id=$1 and r.asset_id=$2 and r.status=\'SUCCEEDED\' order by r.created_at desc limit 1', [input.projectId, assetId]);
      const vision = await this.db.query('select summary,tags from media_analysis_vision_results v join media_analysis_runs r on r.id=v.run_id where r.project_id=$1 and r.asset_id=$2 and r.status=\'SUCCEEDED\' order by r.created_at desc limit 5', [input.projectId, assetId]);
      const metadata = record(row.metadata); const duration = latest.rows[0]?.duration_ms ? Number(latest.rows[0].duration_ms) : typeof metadata.durationMs === 'number' ? metadata.durationMs : 1_000;
      assets.push({ id: String(row.id), sourcePath: String(row.storage_key), durationMs: Math.max(1, duration), summary: vision.rows.map((item) => String(item.summary || '')).join(' '), tags: [...new Set([...tags(metadata.tags), ...vision.rows.flatMap((item) => tags(item.tags))])], qualityScore: typeof metadata.qualityScore === 'number' ? metadata.qualityScore : 0.5 });
    }
    const plan = planIntelligentEdit({ id: input.id || `intelligent-plan-${randomUUID()}`, projectId: input.projectId, ...(input.seed === undefined ? {} : { seed: input.seed }), sentences: input.sentences, assets, config: input.config });
    await this.db.query('insert into intelligent_edit_plans (id,project_id,status,config,source_analysis_run_ids,manifest,quality) values ($1,$2,$3,$4,$5,$6,$7)', [plan.id, plan.projectId, 'READY', JSON.stringify(plan.config), JSON.stringify([]), JSON.stringify(plan.manifest), JSON.stringify(plan.quality)]);
    for (const candidate of plan.candidates) await this.db.query('insert into intelligent_edit_candidates (id,plan_id,sentence_id,asset_id,score,selected,reasons,features) values ($1,$2,$3,$4,$5,$6,$7,$8)', [candidate.id, plan.id, candidate.sentenceId, candidate.assetId, candidate.score, candidate.selected, JSON.stringify(candidate.reasons), JSON.stringify(candidate.features)]);
    await this.db.query('insert into intelligent_edit_evaluations (id,plan_id,evaluator_version,quality) values ($1,$2,$3,$4)', [`evaluation-${plan.id}`, plan.id, 'intelligent-evaluator-v1', JSON.stringify(plan.quality)]);
    return plan;
  }

  async getPlan(projectId: string, planId: string): Promise<IntelligentEditPlanV1 | null> {
    const plan = await this.db.query('select * from intelligent_edit_plans where project_id=$1 and id=$2', [projectId, planId]);
    const row = plan.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const candidates = await this.db.query('select * from intelligent_edit_candidates where plan_id=$1 order by sentence_id,score desc,id', [planId]);
    return { schemaVersion: 'INTELLIGENT_EDIT_PLAN_V1', id: String(row.id), projectId: String(row.project_id), config: row.config as IntelligentPlannerConfigV1, manifest: row.manifest as IntelligentEditPlanV1['manifest'], candidates: candidates.rows.map((candidate) => ({ id: String(candidate.id), sentenceId: String(candidate.sentence_id), assetId: String(candidate.asset_id), shotId: null, score: Number(candidate.score), selected: Boolean(candidate.selected), reasons: Array.isArray(candidate.reasons) ? candidate.reasons.map(String) : [], features: record(candidate.features) as unknown as IntelligentEditPlanV1['candidates'][number]['features'] })), quality: row.quality as IntelligentEditPlanV1['quality'], createdAt: new Date(String(row.created_at)).toISOString() };
  }
}
