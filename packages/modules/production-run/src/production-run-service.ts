import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  PRODUCTION_RUN_STAGES,
  type DigitalHumanMode,
  type ProductionRunDetail,
  type ProductionRunRecord,
  type ProductionRunStage,
  type ProductionRunStatus,
  type ProductionRunStepRecord,
  type ProductionStepStatus,
  validateProductionDomainRefs,
} from '../../../contracts/src/index.js';

const TERMINAL_STEP_STATUSES = new Set<ProductionStepStatus>(['SUCCEEDED', 'SKIPPED', 'CANCELLED']);

function iso(value: unknown): string | null { return value ? new Date(String(value)).toISOString() : null; }
function mapRun(row: Record<string, unknown>): ProductionRunRecord {
  return {
    id: String(row.id), projectId: String(row.project_id), title: String(row.title), template: 'STANDARD_SHORT_VIDEO',
    status: String(row.status) as ProductionRunStatus, currentStage: String(row.current_stage) as ProductionRunStage,
    digitalHumanMode: String(row.digital_human_mode) as DigitalHumanMode, approvalRequired: Boolean(row.approval_required),
    approvalBypassed: Boolean(row.approval_bypassed), metadata: (row.metadata || {}) as Record<string, unknown>,
    startedAt: iso(row.started_at), completedAt: iso(row.completed_at), failedAt: iso(row.failed_at),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}
function mapStep(row: Record<string, unknown>): ProductionRunStepRecord {
  return {
    id: String(row.id), productionRunId: String(row.production_run_id), stage: String(row.stage) as ProductionRunStage,
    status: String(row.status) as ProductionStepStatus, attempt: Number(row.attempt), idempotencyKey: String(row.idempotency_key),
    startedAt: iso(row.started_at), completedAt: iso(row.completed_at), errorCode: row.error_code ? String(row.error_code) : null,
    staleAt: iso(row.stale_at),
    errorMessage: row.error_message ? String(row.error_message) : null,
    inputRefs: (row.input_refs || {}) as Record<string, string | string[]>, outputRefs: (row.output_refs || {}) as Record<string, string | string[]>,
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export interface CreateProductionRunInput {
  projectId: string;
  title: string;
  digitalHumanMode?: DigitalHumanMode;
  approvalRequired?: boolean;
  approvalBypassed?: boolean;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface UpdateProductionStepInput {
  stage: ProductionRunStage;
  status: ProductionStepStatus;
  inputRefs?: Record<string, unknown>;
  outputRefs?: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface UpdateProductionStepOptions {
  allowTerminalTransition?: boolean;
}

function stableRefs(value: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(value).sort().reduce<Record<string, unknown>>((result, key) => {
    const item = value[key];
    result[key] = Array.isArray(item) ? [...item].sort() : item;
    return result;
  }, {}));
}

const STAGE_REQUIRED_REFS: Record<ProductionRunStage, string[]> = {
  CONTENT: ['scriptRevisionId'], VOICE: ['voiceAssetId'], DIGITAL_HUMAN: ['digitalHumanAssetId'], MATERIALS: ['materialPoolSnapshotId'],
  EDITING: ['editSessionId', 'manifestRevisionId'], PREVIEW: ['previewAssetId'], APPROVAL: ['approvalId'], RENDER: ['renderAssetId'],
  PUBLISH: ['publishJobId'], REVIEW: ['reviewId'],
};

export class ProductionRunService {
  constructor(private readonly db: Pool) {}

  async create(input: CreateProductionRunInput): Promise<ProductionRunDetail> {
    const title = input.title.trim();
    if (!title || title.length > 200) throw new Error('PRODUCTION_RUN_TITLE_INVALID');
    const digitalHumanMode = input.digitalHumanMode || 'NONE';
    const approvalRequired = input.approvalRequired !== false;
    const approvalBypassed = input.approvalBypassed === true;
    if (approvalBypassed && approvalRequired) throw new Error('PRODUCTION_APPROVAL_BYPASS_REQUIRES_DISABLED_APPROVAL');
    const idempotencyKey = input.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const existing = await this.db.query('select id from production_runs where project_id=$1 and idempotency_key=$2', [input.projectId, idempotencyKey]);
      if (existing.rows[0]) return (await this.get(input.projectId, String(existing.rows[0].id)))!;
    }
    const runId = `production-run-${randomUUID()}`;
    const client = await this.db.connect();
    try {
      await client.query('begin');
      await client.query('insert into production_runs (id,project_id,title,digital_human_mode,approval_required,approval_bypassed,metadata,idempotency_key) values ($1,$2,$3,$4,$5,$6,$7,$8)', [runId, input.projectId, title, digitalHumanMode, approvalRequired, approvalBypassed, input.metadata || {}, idempotencyKey]);
      for (const stage of PRODUCTION_RUN_STAGES) {
        const status: ProductionStepStatus = stage === 'DIGITAL_HUMAN' && digitalHumanMode === 'NONE' ? 'SKIPPED' : 'PENDING';
        await client.query('insert into production_run_steps (id,production_run_id,stage,status,idempotency_key) values ($1,$2,$3,$4,$5)', [`production-step-${runId}-${stage.toLowerCase()}`, runId, stage, status, `${runId}:${stage}`]);
      }
      await client.query('commit');
      return (await this.get(input.projectId, runId))!;
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async list(projectId: string): Promise<ProductionRunRecord[]> {
    const result = await this.db.query('select * from production_runs where project_id=$1 order by updated_at desc, id desc', [projectId]);
    return result.rows.map((row) => mapRun(row as Record<string, unknown>));
  }

  async get(projectId: string, runId: string): Promise<ProductionRunDetail | null> {
    const run = (await this.db.query('select * from production_runs where id=$1 and project_id=$2', [runId, projectId])).rows[0] as Record<string, unknown> | undefined;
    if (!run) return null;
    const steps = (await this.db.query('select * from production_run_steps where production_run_id=$1 order by array_position(ARRAY[\'CONTENT\',\'VOICE\',\'DIGITAL_HUMAN\',\'MATERIALS\',\'EDITING\',\'PREVIEW\',\'APPROVAL\',\'RENDER\',\'PUBLISH\',\'REVIEW\'], stage)', [runId])).rows.map((row) => mapStep(row as Record<string, unknown>));
    const trace: Record<string, string | string[] | null> = {};
    for (const step of steps) for (const [key, value] of Object.entries(step.outputRefs)) trace[key] = value;
    return { ...mapRun(run), steps, trace };
  }

  /** Guard every route that can create or mutate a production-domain record. */
  async requireMutableRun(projectId: string, runId: string): Promise<ProductionRunDetail> {
    const run = await this.get(projectId, runId);
    if (!run) throw new Error('PRODUCTION_RUN_NOT_FOUND');
    this.assertRunMutable(run);
    return run;
  }

  async updateStep(projectId: string, runId: string, input: UpdateProductionStepInput, options: UpdateProductionStepOptions = {}): Promise<ProductionRunDetail> {
    const current = await this.get(projectId, runId);
    if (!current) throw new Error('PRODUCTION_RUN_NOT_FOUND');
    this.assertRunMutable(current);
    const inputRefs = validateProductionDomainRefs(input.inputRefs || {});
    const outputRefs = validateProductionDomainRefs(input.outputRefs || {});
    const step = current.steps.find((candidate) => candidate.stage === input.stage);
    if (!step) throw new Error('PRODUCTION_STAGE_INVALID');
    if (TERMINAL_STEP_STATUSES.has(input.status) && !options.allowTerminalTransition) throw new Error('PRODUCTION_TERMINAL_TRANSITION_FORBIDDEN');
    if (TERMINAL_STEP_STATUSES.has(step.status)) {
      if (input.status === step.status && stableRefs({ ...step.outputRefs, ...outputRefs }) === stableRefs(step.outputRefs)) return current;
      throw new Error('PRODUCTION_STEP_ALREADY_SUCCEEDED');
    }
    const updated = await this.db.query('update production_run_steps set status=$3, attempt=case when $3=\'RUNNING\' and status <> \'RUNNING\' then attempt+1 else attempt end, started_at=case when $3=\'RUNNING\' and started_at is null then now() else started_at end, completed_at=case when $3 in (\'SUCCEEDED\',\'SKIPPED\',\'CANCELLED\',\'FAILED\') then now() else completed_at end, error_code=$4,error_message=$5,input_refs=input_refs || $6::jsonb,output_refs=output_refs || $7::jsonb,updated_at=now() where id=$1 and production_run_id=$2 and status not in (\'SUCCEEDED\',\'SKIPPED\',\'CANCELLED\')', [step.id, runId, input.status, input.errorCode || null, input.errorMessage || null, JSON.stringify(inputRefs), JSON.stringify(outputRefs)]);
    if (!updated.rowCount) throw new Error('PRODUCTION_STEP_ALREADY_SUCCEEDED');
    if (input.stage === 'EDITING' && input.status === 'SUCCEEDED') await this.db.query("update production_run_steps set stale_at=now(),updated_at=now() where production_run_id=$1 and stage='PREVIEW' and status='SUCCEEDED' and stale_at is null", [runId]);
    if (input.stage === 'EDITING' && input.status === 'SUCCEEDED' && current.steps.find((candidate) => candidate.stage === 'APPROVAL')?.status === 'SUCCEEDED') await this.db.query("update production_run_steps set status='PENDING',completed_at=null,error_code='APPROVAL_STALE',error_message='Manifest changed after approval; approval is required again',updated_at=now() where production_run_id=$1 and stage='APPROVAL'", [runId]);
    await this.refreshRunState(runId);
    return (await this.get(projectId, runId))!;
  }

  async handoff(projectId: string, runId: string, stage: ProductionRunStage, outputRefs: Record<string, unknown>, status: Extract<ProductionStepStatus, 'SUCCEEDED' | 'SKIPPED'> = 'SUCCEEDED'): Promise<ProductionRunDetail> {
    const current = await this.get(projectId, runId); if (!current) throw new Error('PRODUCTION_RUN_NOT_FOUND');
    this.assertRunMutable(current);
    const step = current.steps.find((candidate) => candidate.stage === stage); if (!step) throw new Error('PRODUCTION_STAGE_INVALID');
    if (status === 'SKIPPED' && stage !== 'DIGITAL_HUMAN' && stage !== 'VOICE' && stage !== 'PUBLISH') throw new Error('PRODUCTION_SKIP_NOT_ALLOWED');
    if (stage === 'DIGITAL_HUMAN' && current.digitalHumanMode === 'NONE') status = 'SKIPPED';
    if (status === 'SUCCEEDED') {
      const alternatives: Partial<Record<ProductionRunStage, string[][]>> = { VOICE: [['voiceAssetId', 'speechGenerationId', 'fallbackTiming']], PREVIEW: [['previewAssetId', 'previewId']], RENDER: [['renderAssetId', 'renderId']], PUBLISH: [['publishJobId', 'publishRequestId', 'externalPostId']], REVIEW: [['reviewId', 'externalPostId']] };
      const alternativeKeys = new Set((alternatives[stage] || []).flat());
      const required = STAGE_REQUIRED_REFS[stage].filter((key) => !alternativeKeys.has(key) && outputRefs[key] === undefined);
      const alternativeMissing = (alternatives[stage] || []).some((keys) => !keys.some((key) => outputRefs[key] !== undefined));
      if (alternativeMissing) throw new Error(`PRODUCTION_HANDOFF_REFS_REQUIRED:${(alternatives[stage] || []).flat().join(',')}`);
      if (required.length) throw new Error(`PRODUCTION_HANDOFF_REFS_REQUIRED:${required.join(',')}`);
      await this.verifyHandoffRefs(projectId, current, stage, outputRefs);
    }
    const previousIndex = PRODUCTION_RUN_STAGES.indexOf(stage);
    for (const previous of current.steps.slice(0, previousIndex)) if (!['SUCCEEDED', 'SKIPPED'].includes(previous.status)) throw new Error(`PRODUCTION_PREVIOUS_STAGE_NOT_READY:${previous.stage}`);
    return this.updateStep(projectId, runId, { stage, status, outputRefs }, { allowTerminalTransition: true });
  }

  private assertRunMutable(run: ProductionRunDetail): void {
    if (run.status === 'CANCELLED' || run.status === 'COMPLETED' || run.status === 'COMPLETED_WITHOUT_PUBLISH') throw new Error('PRODUCTION_RUN_TERMINAL');
  }

  private async verifyHandoffRefs(projectId: string, run: ProductionRunDetail, stage: ProductionRunStage, refs: Record<string, unknown>): Promise<void> {
    const one = (key: string): string | null => typeof refs[key] === 'string' ? String(refs[key]) : null;
    const exists = async (sql: string, params: unknown[]): Promise<boolean> => (await this.db.query(sql, params)).rows.length > 0;
    if (stage === 'CONTENT' && !(await exists("select 1 from director_script_revisions where id=$1 and project_id=$2 and status='ACCEPTED'", [one('scriptRevisionId'), projectId]))) throw new Error('PRODUCTION_SCRIPT_REVISION_NOT_ACCEPTED');
    if (stage === 'VOICE' && one('voiceAssetId') && !(await exists("select 1 from assets where id=$1 and project_id=$2 and lifecycle='READY' and kind='AUDIO'", [one('voiceAssetId'), projectId]))) throw new Error('PRODUCTION_VOICE_ASSET_NOT_READY');
    if (stage === 'VOICE' && one('speechGenerationId') && !(await exists('select 1 from speech_generations where id=$1 and project_id=$2', [one('speechGenerationId'), projectId]))) throw new Error('PRODUCTION_SPEECH_GENERATION_NOT_FOUND');
    if (stage === 'DIGITAL_HUMAN' && !(await exists("select 1 from assets where id=$1 and project_id=$2 and lifecycle='READY' and kind='VIDEO'", [one('digitalHumanAssetId'), projectId]))) throw new Error('PRODUCTION_DIGITAL_HUMAN_ASSET_NOT_READY');
    if (stage === 'MATERIALS' && !(await exists('select 1 from material_pool_snapshots p join video_workspaces w on w.id=p.workspace_id where p.id=$1 and w.project_id=$2', [one('materialPoolSnapshotId'), projectId]))) throw new Error('PRODUCTION_MATERIAL_POOL_NOT_FOUND');
    if (stage === 'EDITING') {
      const editSessionId = one('editSessionId'); const manifestId = one('manifestRevisionId');
      const session = (await this.db.query<{ workspace_id: string; current_manifest_id: string | null; material_pool_snapshot_id: string }>('select s.workspace_id,s.current_manifest_id,s.material_pool_snapshot_id from script_editing_v3_sessions s join video_workspaces w on w.id=s.workspace_id where s.id=$1 and w.project_id=$2', [editSessionId, projectId])).rows[0];
      if (!session) throw new Error('PRODUCTION_EDIT_SESSION_NOT_FOUND');
      if (session.material_pool_snapshot_id !== run.trace.materialPoolSnapshotId) throw new Error('PRODUCTION_EDIT_SESSION_MISMATCH');
      if (session.current_manifest_id !== manifestId) throw new Error('PRODUCTION_MANIFEST_SESSION_MISMATCH');
      if (!(await exists('select 1 from edit_manifests m join video_workspaces w on w.id=m.workspace_id where m.id=$1 and m.workspace_id=$2 and w.project_id=$3 and m.project_id=$3', [manifestId, session.workspace_id, projectId]))) throw new Error('PRODUCTION_MANIFEST_SESSION_MISMATCH');
    }
    if (stage === 'PREVIEW') {
      const manifestId = typeof run.trace.manifestRevisionId === 'string' ? run.trace.manifestRevisionId : null;
      const previewId = one('previewId'); const previewAssetId = one('previewAssetId');
      if (previewId && !(await exists("select 1 from jobs where id=$1 and type='EDIT_V3_DRAFT_PREVIEW' and workspace_id=(select workspace_id from script_editing_v3_sessions where id=$2) and payload->>'manifestId'=$3", [previewId, run.trace.editSessionId, manifestId]))) throw new Error('PRODUCTION_PREVIEW_MANIFEST_MISMATCH');
      if (!previewId && previewAssetId && !(await exists("select 1 from assets where id=$1 and project_id=$2 and lifecycle='READY' and metadata->>'manifestId'=$3", [previewAssetId, projectId, manifestId]))) throw new Error('PRODUCTION_PREVIEW_MANIFEST_MISMATCH');
      if (!previewId && !previewAssetId) throw new Error('PRODUCTION_PREVIEW_MANIFEST_MISMATCH');
    }
    if (stage === 'APPROVAL') {
      const manifestId = typeof run.trace.manifestRevisionId === 'string' ? run.trace.manifestRevisionId : null;
      if (one('manifestRevisionId') !== manifestId) throw new Error('PRODUCTION_APPROVAL_MANIFEST_MISMATCH');
      if (!(await exists("select 1 from approval_decisions where id=$1 and project_id=$2 and target_type='RENDER' and target_id=$3 and target_revision_id=$3 and status='APPROVED'", [one('approvalId'), projectId, manifestId]))) throw new Error('PRODUCTION_APPROVAL_MANIFEST_MISMATCH');
    }
    if (stage === 'RENDER') {
      const manifestId = typeof run.trace.manifestRevisionId === 'string' ? run.trace.manifestRevisionId : null;
      const renderId = one('renderId'); const renderAssetId = one('renderAssetId');
      const render = (await this.db.query<{ id: string; output_asset_id: string | null }>("select r.id,r.output_asset_id from renders r join edit_manifests m on m.id=r.manifest_id and m.id=$3 join assets a on a.id=r.output_asset_id and a.project_id=$2 and a.lifecycle='READY' and a.kind='VIDEO_RENDER' where r.project_id=$2 and r.status='SUCCEEDED' and ($1::text is null or r.id=$1) and ($4::text is null or r.output_asset_id=$4)", [renderId, projectId, manifestId, renderAssetId])).rows[0];
      if (!render || !render.output_asset_id || (renderAssetId && render.output_asset_id !== renderAssetId)) throw new Error(renderId ? 'PRODUCTION_RENDER_MANIFEST_MISMATCH' : 'PRODUCTION_RENDER_ASSET_MANIFEST_MISMATCH');
    }
    if (stage === 'PUBLISH') {
      const renderAssetId = typeof run.trace.renderAssetId === 'string' ? run.trace.renderAssetId : null;
      const requestId = one('publishRequestId'); const jobId = one('publishJobId');
      if (!(await exists('select 1 from publisher_requests p join publisher_request_revisions r on r.id=p.current_revision_id where p.id=$1 and p.project_id=$2 and r.asset_id=$3', [requestId, projectId, renderAssetId]))) throw new Error('PRODUCTION_PUBLISH_REQUEST_MISMATCH');
      if (jobId && !(await exists("select 1 from jobs where id=$1 and project_id=$2 and type='PUBLISH' and payload->>'requestId'=$3", [jobId, projectId, requestId]))) throw new Error('PRODUCTION_PUBLISH_REQUEST_MISMATCH');
    }
    if (stage === 'REVIEW') {
      const externalPostId = one('externalPostId'); const requestId = typeof run.trace.publishRequestId === 'string' ? run.trace.publishRequestId : null;
      if (externalPostId && !(await exists('select 1 from publisher_external_posts p join publisher_requests r on r.id=p.request_id where p.external_post_id=$1 and p.request_id=$2 and r.project_id=$3', [externalPostId, requestId, projectId]))) throw new Error('PRODUCTION_EXTERNAL_POST_NOT_FOUND');
      if (one('reviewId') && !(await exists('select 1 from review_metric_snapshots s join publisher_external_posts p on p.external_post_id=s.external_post_id where s.id=$1 and s.project_id=$2 and s.external_post_id=$3 and p.request_id=$4', [one('reviewId'), projectId, externalPostId || run.trace.externalPostId, requestId]))) throw new Error('PRODUCTION_REVIEW_NOT_FOUND');
      if (!externalPostId && !one('reviewId')) throw new Error('PRODUCTION_REVIEW_NOT_FOUND');
    }
  }

  async retry(projectId: string, runId: string, stage: ProductionRunStage): Promise<ProductionRunDetail> {
    const current = await this.get(projectId, runId);
    if (!current) throw new Error('PRODUCTION_RUN_NOT_FOUND');
    this.assertRunMutable(current);
    const step = current.steps.find((candidate) => candidate.stage === stage);
    if (!step || step.status !== 'FAILED') throw new Error('PRODUCTION_RETRY_STAGE_NOT_FAILED');
    await this.db.query("update production_run_steps set status='PENDING',error_code=null,error_message=null,completed_at=null,updated_at=now() where id=$1", [step.id]);
    await this.db.query("update production_runs set status='RUNNING',failed_at=null,updated_at=now() where id=$1", [runId]);
    return (await this.get(projectId, runId))!;
  }

  async resetForChanges(projectId: string, runId: string): Promise<ProductionRunDetail> {
    const current = await this.get(projectId, runId); if (!current) throw new Error('PRODUCTION_RUN_NOT_FOUND');
    this.assertRunMutable(current);
    const approval = current.steps.find((step) => step.stage === 'APPROVAL'); if (!approval || !['WAITING_USER', 'FAILED', 'SUCCEEDED'].includes(approval.status)) throw new Error('PRODUCTION_APPROVAL_REQUIRED');
    await this.db.query("update production_run_steps set status='PENDING',completed_at=null,error_code=null,error_message=null,input_refs='{}'::jsonb,output_refs='{}'::jsonb,stale_at=null,updated_at=now() where production_run_id=$1 and stage in ('EDITING','PREVIEW','APPROVAL','RENDER','PUBLISH','REVIEW')", [runId]);
    await this.db.query("update production_runs set status='RUNNING',current_stage='EDITING',failed_at=null,completed_at=null,updated_at=now() where id=$1", [runId]);
    return (await this.get(projectId, runId))!;
  }

  async cancel(projectId: string, runId: string): Promise<ProductionRunDetail> {
    const current = await this.get(projectId, runId);
    if (!current) throw new Error('PRODUCTION_RUN_NOT_FOUND');
    if (current.status === 'CANCELLED') return current;
    this.assertRunMutable(current);
    const jobIds = current.steps.flatMap((step) => Object.entries(step.outputRefs).filter(([key]) => key === 'jobId' || key === 'publishJobId').flatMap(([, value]) => Array.isArray(value) ? value : [value]));
    await this.db.query("update production_run_steps set status='CANCELLED',completed_at=coalesce(completed_at,now()),updated_at=now() where production_run_id=$1 and status in ('PENDING','RUNNING','WAITING_USER')", [runId]);
    if (jobIds.length) await this.db.query("update jobs set state=case when state='RUNNING' then 'CANCEL_REQUESTED' else 'CANCELLED' end,updated_at=now() where id=any($1::text[]) and state in ('QUEUED','RUNNING','RETRY_WAIT')", [jobIds]);
    await this.db.query("update production_runs set status='CANCELLED',updated_at=now() where id=$1", [runId]);
    return (await this.get(projectId, runId))!;
  }

  async reconcile(projectId: string, runId: string): Promise<ProductionRunDetail> {
    const current = await this.get(projectId, runId);
    if (!current) throw new Error('PRODUCTION_RUN_NOT_FOUND');
    if (current.status === 'CANCELLED' || current.status === 'COMPLETED' || current.status === 'COMPLETED_WITHOUT_PUBLISH') return current;
    let state = current;
    for (const step of current.steps) {
      const jobIds = Object.entries(step.outputRefs).filter(([key]) => key === 'jobId' || key === 'publishJobId').flatMap(([, value]) => Array.isArray(value) ? value : [value]);
      if (!jobIds.length) continue;
      const jobs = await this.db.query<{ id: string; state: string; error: { code?: string; message?: string } | null; result: Record<string, unknown> | null }>('select id,state,error,result from jobs where id=any($1::text[]) and project_id=$2 order by updated_at desc', [jobIds, projectId]);
      const job = jobs.rows[0];
      const outputRefs: Record<string, unknown> = {};
      if (job?.state === 'SUCCEEDED' && step.stage === 'RENDER') {
        const render = (await this.db.query<{ id: string; output_asset_id: string | null }>('select id,output_asset_id from renders where job_id=$1 order by created_at desc limit 1', [job.id])).rows[0];
        if (render) { outputRefs.renderId = render.id; outputRefs.manifestRevisionId = state.trace.manifestRevisionId as string; if (render.output_asset_id) outputRefs.renderAssetId = render.output_asset_id; }
      }
      if (job?.state === 'SUCCEEDED' && step.stage === 'PREVIEW') outputRefs.previewId = job.id;
      if (job?.state === 'SUCCEEDED' && step.stage === 'PUBLISH') {
        const post = (await this.db.query<{ external_post_id: string }>('select p.external_post_id from publisher_external_posts p join publisher_attempts a on a.request_id=p.request_id where a.job_id=$1 order by p.first_observed_at desc limit 1', [job.id])).rows[0];
        if (post) { outputRefs.externalPostId = post.external_post_id; outputRefs.publishJobId = job.id; outputRefs.publishRequestId = step.outputRefs.publishRequestId as string; }
      }
      if (job?.state === 'SUCCEEDED' && step.stage === 'VOICE') {
        const generationId = typeof step.outputRefs.speechGenerationId === 'string' ? step.outputRefs.speechGenerationId : null;
        if (generationId) { const generation = (await this.db.query<{ output_asset_id: string | null }>('select output_asset_id from speech_generations where id=$1 and project_id=$2', [generationId, projectId])).rows[0]; if (generation?.output_asset_id) outputRefs.voiceAssetId = generation.output_asset_id; }
      }
      if (job?.state === 'SUCCEEDED' && step.stage === 'DIGITAL_HUMAN') {
        const generationId = typeof step.outputRefs.avatarGenerationId === 'string' ? step.outputRefs.avatarGenerationId : null;
        if (generationId) { const generation = (await this.db.query<{ output_asset_id: string | null }>('select output_asset_id from avatar_generations where id=$1 and project_id=$2', [generationId, projectId])).rows[0]; if (generation?.output_asset_id) outputRefs.digitalHumanAssetId = generation.output_asset_id; }
      }
      if (job?.state === 'SUCCEEDED' && step.status !== 'SUCCEEDED') {
        const refs = { ...step.outputRefs, ...outputRefs };
        await this.verifyHandoffRefs(projectId, state, step.stage, refs);
        state = await this.updateStep(projectId, runId, { stage: step.stage, status: 'SUCCEEDED', outputRefs }, { allowTerminalTransition: true });
      } else if (job && ['FAILED', 'BLOCKED'].includes(job.state) && step.status !== 'FAILED') state = await this.updateStep(projectId, runId, { stage: step.stage, status: 'FAILED', errorCode: job.error?.code || 'DOMAIN_JOB_FAILED', errorMessage: job.error?.message || 'Domain job failed' }, { allowTerminalTransition: true });
    }
    return (await this.get(projectId, runId))!;
  }

  private async refreshRunState(runId: string): Promise<void> {
    const run = (await this.db.query<{ status: ProductionRunStatus; current_stage: ProductionRunStage }>('select status,current_stage from production_runs where id=$1', [runId])).rows[0];
    if (!run || run.status === 'CANCELLED') return;
    const rows = await this.db.query<{ stage: ProductionRunStage; status: ProductionStepStatus }>('select stage,status from production_run_steps where production_run_id=$1 order by array_position(ARRAY[\'CONTENT\',\'VOICE\',\'DIGITAL_HUMAN\',\'MATERIALS\',\'EDITING\',\'PREVIEW\',\'APPROVAL\',\'RENDER\',\'PUBLISH\',\'REVIEW\'], stage)', [runId]);
    const firstOpen = rows.rows.find((row) => !TERMINAL_STEP_STATUSES.has(row.status));
    const status: ProductionRunStatus = rows.rows.some((row) => row.status === 'FAILED') ? 'FAILED' : rows.rows.some((row) => row.status === 'WAITING_USER') ? 'WAITING_USER' : rows.rows.every((row) => TERMINAL_STEP_STATUSES.has(row.status)) ? (rows.rows.some((row) => row.stage === 'PUBLISH' && row.status === 'SKIPPED') ? 'COMPLETED_WITHOUT_PUBLISH' : 'COMPLETED') : 'RUNNING';
    await this.db.query('update production_runs set status=$2,current_stage=$3,started_at=coalesce(started_at,case when $2<>\'DRAFT\' then now() else null end),completed_at=case when $2 in (\'COMPLETED\',\'COMPLETED_WITHOUT_PUBLISH\') then coalesce(completed_at,now()) else null end,failed_at=case when $2=\'FAILED\' then coalesce(failed_at,now()) else null end,updated_at=now() where id=$1 and status not in (\'CANCELLED\',\'COMPLETED\',\'COMPLETED_WITHOUT_PUBLISH\')', [runId, status, firstOpen?.stage || run.current_stage]);
  }
}
