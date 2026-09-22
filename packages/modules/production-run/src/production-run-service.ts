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

  async updateStep(projectId: string, runId: string, input: UpdateProductionStepInput): Promise<ProductionRunDetail> {
    const current = await this.get(projectId, runId);
    if (!current) throw new Error('PRODUCTION_RUN_NOT_FOUND');
    const inputRefs = validateProductionDomainRefs(input.inputRefs || {});
    const outputRefs = validateProductionDomainRefs(input.outputRefs || {});
    const step = current.steps.find((candidate) => candidate.stage === input.stage);
    if (!step) throw new Error('PRODUCTION_STAGE_INVALID');
    if (step.status === 'SUCCEEDED' && input.status === 'RUNNING') throw new Error('PRODUCTION_STEP_ALREADY_SUCCEEDED');
    const runStatus = input.status === 'FAILED' ? 'FAILED' : input.status === 'WAITING_USER' ? 'WAITING_USER' : 'RUNNING';
    await this.db.query('update production_run_steps set status=$3, attempt=case when $3=\'RUNNING\' and status <> \'RUNNING\' then attempt+1 else attempt end, started_at=case when $3=\'RUNNING\' and started_at is null then now() else started_at end, completed_at=case when $3 in (\'SUCCEEDED\',\'SKIPPED\',\'CANCELLED\',\'FAILED\') then now() else completed_at end, error_code=$4,error_message=$5,input_refs=input_refs || $6::jsonb,output_refs=output_refs || $7::jsonb,updated_at=now() where id=$1 and production_run_id=$2', [step.id, runId, input.status, input.errorCode || null, input.errorMessage || null, JSON.stringify(inputRefs), JSON.stringify(outputRefs)]);
    await this.refreshRunState(runId, runStatus);
    return (await this.get(projectId, runId))!;
  }

  async retry(projectId: string, runId: string, stage: ProductionRunStage): Promise<ProductionRunDetail> {
    const current = await this.get(projectId, runId);
    if (!current) throw new Error('PRODUCTION_RUN_NOT_FOUND');
    const step = current.steps.find((candidate) => candidate.stage === stage);
    if (!step || step.status !== 'FAILED') throw new Error('PRODUCTION_RETRY_STAGE_NOT_FAILED');
    await this.db.query("update production_run_steps set status='PENDING',error_code=null,error_message=null,completed_at=null,updated_at=now() where id=$1", [step.id]);
    await this.db.query("update production_runs set status='RUNNING',failed_at=null,updated_at=now() where id=$1", [runId]);
    return (await this.get(projectId, runId))!;
  }

  async cancel(projectId: string, runId: string): Promise<ProductionRunDetail> {
    const current = await this.get(projectId, runId);
    if (!current) throw new Error('PRODUCTION_RUN_NOT_FOUND');
    const jobIds = current.steps.flatMap((step) => Object.entries(step.outputRefs).filter(([key]) => key === 'jobId' || key === 'publishJobId').flatMap(([, value]) => Array.isArray(value) ? value : [value]));
    await this.db.query("update production_run_steps set status='CANCELLED',completed_at=coalesce(completed_at,now()),updated_at=now() where production_run_id=$1 and status in ('PENDING','RUNNING','WAITING_USER')", [runId]);
    if (jobIds.length) await this.db.query("update jobs set state=case when state='RUNNING' then 'CANCEL_REQUESTED' else 'CANCELLED' end,updated_at=now() where id=any($1::text[]) and state in ('QUEUED','RUNNING','RETRY_WAIT')", [jobIds]);
    await this.db.query("update production_runs set status='CANCELLED',updated_at=now() where id=$1", [runId]);
    return (await this.get(projectId, runId))!;
  }

  async reconcile(projectId: string, runId: string): Promise<ProductionRunDetail> {
    const current = await this.get(projectId, runId);
    if (!current) throw new Error('PRODUCTION_RUN_NOT_FOUND');
    for (const step of current.steps) {
      const jobIds = Object.entries(step.outputRefs).filter(([key]) => key === 'jobId' || key === 'publishJobId').flatMap(([, value]) => Array.isArray(value) ? value : [value]);
      if (!jobIds.length) continue;
      const jobs = await this.db.query<{ state: string; error: { code?: string; message?: string } | null }>('select state,error from jobs where id=any($1::text[]) order by updated_at desc', [jobIds]);
      const job = jobs.rows[0];
      if (job?.state === 'SUCCEEDED' && step.status !== 'SUCCEEDED') await this.updateStep(projectId, runId, { stage: step.stage, status: 'SUCCEEDED' });
      else if (job && ['FAILED', 'BLOCKED'].includes(job.state) && step.status !== 'FAILED') await this.updateStep(projectId, runId, { stage: step.stage, status: 'FAILED', errorCode: job.error?.code || 'DOMAIN_JOB_FAILED', errorMessage: job.error?.message || 'Domain job failed' });
    }
    return (await this.get(projectId, runId))!;
  }

  private async refreshRunState(runId: string, explicit: ProductionRunStatus): Promise<void> {
    const rows = await this.db.query<{ stage: ProductionRunStage; status: ProductionStepStatus }>('select stage,status from production_run_steps where production_run_id=$1 order by array_position(ARRAY[\'CONTENT\',\'VOICE\',\'DIGITAL_HUMAN\',\'MATERIALS\',\'EDITING\',\'PREVIEW\',\'APPROVAL\',\'RENDER\',\'PUBLISH\',\'REVIEW\'], stage)', [runId]);
    const firstOpen = rows.rows.find((row) => !TERMINAL_STEP_STATUSES.has(row.status));
    const status: ProductionRunStatus = rows.rows.every((row) => TERMINAL_STEP_STATUSES.has(row.status)) ? (rows.rows.some((row) => row.stage === 'PUBLISH' && row.status === 'SKIPPED') ? 'COMPLETED_WITHOUT_PUBLISH' : 'COMPLETED') : explicit;
    await this.db.query('update production_runs set status=$2,current_stage=$3,started_at=coalesce(started_at,case when $2<>\'DRAFT\' then now() else null end),completed_at=case when $2 in (\'COMPLETED\',\'COMPLETED_WITHOUT_PUBLISH\') then coalesce(completed_at,now()) else null end,failed_at=case when $2=\'FAILED\' then coalesce(failed_at,now()) else null end,updated_at=now() where id=$1', [runId, status, firstOpen?.stage || 'REVIEW']);
  }
}
