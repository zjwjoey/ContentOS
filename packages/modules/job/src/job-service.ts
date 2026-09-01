import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export type JobState = 'QUEUED' | 'RUNNING' | 'RETRY_WAIT' | 'FAILED' | 'SUCCEEDED' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'BLOCKED';
export interface JobRecord { id: string; projectId: string | null; workspaceId: string | null; type: string; state: JobState; payload: unknown; result: unknown; error: unknown; attemptCount: number; maxAttempts: number; leaseOwner: string | null; leaseExpiresAt: Date | null; progress: unknown; }
export interface JobSummary { id: string; projectId: string; type: string; state: JobState; attemptCount: number; maxAttempts: number; createdAt: string; }
export interface ProjectJobStateSummary { stateCounts: Record<string, number>; videoStateCounts: Record<string, number>; }
export interface CreateJobInput { id: string; type: string; projectId: string | null; workspaceId?: string | null; payload: unknown; idempotencyKey: string; maxAttempts: number; scheduledAt?: Date | string | null; }
export type JobHeartbeat = 'ACTIVE' | 'CANCEL_REQUESTED' | 'STALE';
export type JobAttemptFenceResult<T> = { executed: true; value: T } | { executed: false };
export type JobAttemptCommitResult<T> = { executed: true; value: T; job: JobRecord } | { executed: false; job: JobRecord };
export type JobLeaseCancellationHandler = (job: JobRecord, scope: JobAttemptScope) => Promise<boolean>;

const jobAttemptScopeBrand: unique symbol = Symbol('JobAttemptScope');
export interface JobAttemptScope {
  readonly [jobAttemptScopeBrand]: true;
  readonly jobId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

class ActiveJobAttemptScope implements JobAttemptScope {
  readonly [jobAttemptScopeBrand] = true;
  private active = true;
  constructor(readonly jobId: string, readonly attemptId: string, readonly attemptNumber: number, private readonly client: PoolClient) {}
  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
    if (!this.active) throw new Error('Job attempt transaction is no longer active');
    return this.client.query<T>(text, values);
  }
  close(): void { this.active = false; }
}

function mapJob(row: Record<string, unknown>): JobRecord {
  return { id: String(row.id), projectId: row.project_id ? String(row.project_id) : null, workspaceId: row.workspace_id ? String(row.workspace_id) : null, type: String(row.type), state: row.state as JobState, payload: row.payload, result: row.result, error: row.error, attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts), leaseOwner: row.lease_owner ? String(row.lease_owner) : null, leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)) : null, progress: row.progress };
}

export class JobService {
  constructor(private readonly db: Pool) {}

  async create(input: CreateJobInput): Promise<JobRecord> {
    const result = await this.db.query('insert into jobs (id, project_id, workspace_id, type, state, idempotency_key, payload, max_attempts, scheduled_at) values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, now())) returning *', [input.id, input.projectId, input.workspaceId || null, input.type, 'QUEUED', input.idempotencyKey, input.payload, input.maxAttempts, input.scheduledAt || null]);
    return mapJob(result.rows[0] as Record<string, unknown>);
  }

  async createIdempotent(input: CreateJobInput): Promise<JobRecord> {
    const result = await this.db.query('insert into jobs (id, project_id, workspace_id, type, state, idempotency_key, payload, max_attempts, scheduled_at) values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, now())) on conflict (idempotency_key) do update set id = jobs.id returning *', [input.id, input.projectId, input.workspaceId || null, input.type, 'QUEUED', input.idempotencyKey, input.payload, input.maxAttempts, input.scheduledAt || null]);
    return mapJob(result.rows[0] as Record<string, unknown>);
  }

  async get(id: string): Promise<JobRecord | null> {
    const result = await this.db.query('select * from jobs where id = $1', [id]);
    return result.rows[0] ? mapJob(result.rows[0] as Record<string, unknown>) : null;
  }
  async getByIdempotencyKey(idempotencyKey: string): Promise<JobRecord | null> {
    const result = await this.db.query('select * from jobs where idempotency_key = $1', [idempotencyKey]);
    return result.rows[0] ? mapJob(result.rows[0] as Record<string, unknown>) : null;
  }
  async listProjectSummaries(projectId: string, limit = 8): Promise<JobSummary[]> {
    if (!projectId || limit <= 0) return [];
    const result = await this.db.query('select id, project_id, type, state, attempt_count, max_attempts, created_at from jobs where project_id = $1 order by created_at desc, id desc limit $2', [projectId, Math.min(limit, 20)]);
    return result.rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      type: String(row.type),
      state: row.state as JobState,
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      createdAt: new Date(String(row.created_at)).toISOString(),
    }));
  }
  async listProjectFailedSummaries(projectId: string, limit = 8): Promise<JobSummary[]> {
    if (!projectId || limit <= 0) return [];
    const result = await this.db.query("select id, project_id, type, state, attempt_count, max_attempts, created_at from jobs where project_id = $1 and state in ('FAILED', 'BLOCKED') order by created_at desc, id desc limit $2", [projectId, Math.min(limit, 20)]);
    return result.rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      type: String(row.type),
      state: row.state as JobState,
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      createdAt: new Date(String(row.created_at)).toISOString(),
    }));
  }
  async getProjectStateSummary(projectId: string): Promise<ProjectJobStateSummary> {
    const result = await this.db.query("select type, state, count(*)::text as count from jobs where project_id = $1 and state in ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'FAILED', 'BLOCKED') group by type, state", [projectId]);
    const stateCounts: Record<string, number> = {};
    const videoStateCounts: Record<string, number> = {};
    for (const row of result.rows as Array<{ type: string; state: string; count: string }>) {
      const count = Number(row.count);
      stateCounts[row.state] = (stateCounts[row.state] || 0) + count;
      if (row.type === 'VIDEO_RENDER') videoStateCounts[row.state] = (videoStateCounts[row.state] || 0) + count;
    }
    return { stateCounts, videoStateCounts };
  }

  async listRunnable(types: string[], limit = 10): Promise<JobRecord[]> {
    if (types.length === 0 || limit <= 0) return [];
    const result = await this.db.query("select * from jobs where type = any($1::text[]) and scheduled_at <= now() and (state = 'QUEUED' or (state = 'RETRY_WAIT' and (retry_at is null or retry_at <= now()))) order by created_at, id limit $2", [types, limit]);
    return result.rows.map((row) => mapJob(row as Record<string, unknown>));
  }

  async claim(id: string, workerId: string, leaseMs: number): Promise<{ job: JobRecord; attemptId: string } | null> {
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const selected = await client.query('select * from jobs where id = $1 for update', [id]);
      const row = selected.rows[0] as Record<string, unknown> | undefined;
      if (!row || !['QUEUED', 'RETRY_WAIT'].includes(String(row.state))) { await client.query('rollback'); return null; }
      if (row.scheduled_at && new Date(String(row.scheduled_at)).getTime() > Date.now()) { await client.query('rollback'); return null; }
      const attemptNumber = Number(row.attempt_count) + 1;
      const attemptId = randomUUID();
      const leaseExpires = new Date(Date.now() + leaseMs);
      const updated = await client.query('update jobs set state = $2, attempt_count = $3, lease_owner = $4, lease_expires_at = $5, updated_at = now() where id = $1 returning *', [id, 'RUNNING', attemptNumber, workerId, leaseExpires]);
      await client.query('insert into job_attempts (id, job_id, attempt_number, worker_id, status) values ($1, $2, $3, $4, $5)', [attemptId, id, attemptNumber, workerId, 'RUNNING']);
      await client.query('insert into job_events (job_id, event_type, details) values ($1, $2, $3)', [id, 'job.claimed', { workerId, attemptId, attemptNumber }]);
      await client.query('commit');
      return { job: mapJob(updated.rows[0] as Record<string, unknown>), attemptId };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async succeed(id: string, attemptId: string, result: unknown): Promise<JobRecord> {
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const selected = await client.query('select * from jobs where id = $1 for update', [id]);
      const current = selected.rows[0] as Record<string, unknown> | undefined;
      if (!current) throw new Error(`Job ${id} not found`);
      const attempt = await client.query<{ attempt_number: number; status: string }>('select attempt_number, status from job_attempts where id = $1 and job_id = $2', [attemptId, id]);
      const active = attempt.rows[0];
      if (!active || active.status !== 'RUNNING' || Number(active.attempt_number) !== Number(current.attempt_count) || current.state !== 'RUNNING') {
        await client.query('commit');
        return mapJob(current);
      }
      await client.query('update job_attempts set status = $2, finished_at = now() where id = $1', [attemptId, 'SUCCEEDED']);
      const updated = await client.query('update jobs set state = $2, result = $3, lease_owner = null, lease_expires_at = null, updated_at = now() where id = $1 returning *', [id, 'SUCCEEDED', result]);
      await client.query('insert into job_events (job_id, event_type, details) values ($1, $2, $3)', [id, 'job.succeeded', { attemptId }]);
      await client.query('commit');
      return mapJob(updated.rows[0] as Record<string, unknown>);
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async fail(id: string, attemptId: string, error: unknown, retryable: boolean, action?: (scope: JobAttemptScope) => Promise<void>): Promise<JobRecord> {
    const client = await this.db.connect();
    let scope: ActiveJobAttemptScope | null = null;
    try {
      await client.query('begin');
      const selected = await client.query('select * from jobs where id = $1 for update', [id]);
      const current = selected.rows[0] as Record<string, unknown> | undefined;
      if (!current) throw new Error(`Job ${id} not found`);
      const attempt = await client.query<{ attempt_number: number; status: string }>('select attempt_number, status from job_attempts where id = $1 and job_id = $2', [attemptId, id]);
      const active = attempt.rows[0];
      if (!active || active.status !== 'RUNNING' || Number(active.attempt_number) !== Number(current.attempt_count) || current.state !== 'RUNNING') {
        await client.query('commit');
        return mapJob(current);
      }
      if (action) {
        scope = new ActiveJobAttemptScope(id, attemptId, Number(active.attempt_number), client);
        await action(scope);
      }
      const retry = retryable && Number(current.attempt_count) < Number(current.max_attempts);
      const state: JobState = retry ? 'RETRY_WAIT' : 'FAILED';
      await client.query('update job_attempts set status = $2, error = $3, finished_at = now() where id = $1', [attemptId, 'FAILED', error]);
      const result = await client.query('update jobs set state = $2, error = $3, retry_at = case when $2 = \'RETRY_WAIT\' then now() + interval \'1 second\' else null end, lease_owner = null, lease_expires_at = null, updated_at = now() where id = $1 returning *', [id, state, error]);
      await client.query('insert into job_events (job_id, event_type, details) values ($1, $2, $3)', [id, retry ? 'job.retry_scheduled' : 'job.failed', { attemptId, retryable }]);
      await client.query('commit');
      return mapJob(result.rows[0] as Record<string, unknown>);
    } catch (failure) { await client.query('rollback'); throw failure; }
    finally { scope?.close(); client.release(); }
  }

  async requeue(id: string): Promise<void> { await this.db.query("update jobs set state = 'QUEUED', retry_at = null, updated_at = now() where id = $1 and state = 'RETRY_WAIT'", [id]); }

  async requestCancel(id: string): Promise<void> {
    await this.db.query("update jobs set state = case when state = 'RUNNING' then 'CANCEL_REQUESTED' else 'CANCELLED' end, retry_at = null, lease_owner = case when state = 'RUNNING' then lease_owner else null end, lease_expires_at = case when state = 'RUNNING' then lease_expires_at else null end, updated_at = now() where id = $1 and state in ('QUEUED','RUNNING','RETRY_WAIT')", [id]);
  }

  async heartbeat(id: string, attemptId: string, leaseMs: number): Promise<JobHeartbeat> {
    if (leaseMs <= 0) return 'STALE';
    const leaseExpires = new Date(Date.now() + leaseMs);
    const renewed = await this.db.query("update jobs j set lease_expires_at = $3, updated_at = now() where j.id = $1 and j.state = 'RUNNING' and exists (select 1 from job_attempts a where a.id = $2 and a.job_id = j.id and a.status = 'RUNNING' and a.attempt_number = j.attempt_count) returning j.id", [id, attemptId, leaseExpires]);
    if (renewed.rowCount) return 'ACTIVE';
    const cancellation = await this.db.query("select j.id from jobs j where j.id = $1 and j.state = 'CANCEL_REQUESTED' and exists (select 1 from job_attempts a where a.id = $2 and a.job_id = j.id and a.status = 'RUNNING' and a.attempt_number = j.attempt_count)", [id, attemptId]);
    return cancellation.rowCount ? 'CANCEL_REQUESTED' : 'STALE';
  }

  async renewLease(id: string, attemptId: string, leaseMs: number): Promise<boolean> {
    return (await this.heartbeat(id, attemptId, leaseMs)) === 'ACTIVE';
  }

  async withCurrentAttemptFence<T>(id: string, attemptId: string, action: (scope: JobAttemptScope) => Promise<T>): Promise<JobAttemptFenceResult<T>> {
    const client = await this.db.connect();
    let scope: ActiveJobAttemptScope | null = null;
    try {
      await client.query('begin');
      const selected = await client.query('select state, attempt_count from jobs where id = $1 for update', [id]);
      const current = selected.rows[0] as { state: JobState; attempt_count: number } | undefined;
      if (!current || current.state !== 'RUNNING') {
        await client.query('commit');
        return { executed: false };
      }
      const attempt = await client.query<{ attempt_number: number }>("select attempt_number from job_attempts where id = $1 and job_id = $2 and status = 'RUNNING'", [attemptId, id]);
      if (!attempt.rows[0] || Number(attempt.rows[0].attempt_number) !== Number(current.attempt_count)) {
        await client.query('commit');
        return { executed: false };
      }
      scope = new ActiveJobAttemptScope(id, attemptId, Number(current.attempt_count), client);
      const value = await action(scope);
      await client.query('commit');
      return { executed: true, value };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { scope?.close(); client.release(); }
  }

  async succeedWithCurrentAttempt<T>(id: string, attemptId: string, action: (scope: JobAttemptScope) => Promise<T>): Promise<JobAttemptCommitResult<T>> {
    const client = await this.db.connect();
    let scope: ActiveJobAttemptScope | null = null;
    try {
      await client.query('begin');
      const selected = await client.query('select * from jobs where id = $1 for update', [id]);
      const current = selected.rows[0] as Record<string, unknown> | undefined;
      if (!current) throw new Error(`Job ${id} not found`);
      const attempt = await client.query<{ attempt_number: number; status: string }>('select attempt_number, status from job_attempts where id = $1 and job_id = $2', [attemptId, id]);
      const active = attempt.rows[0];
      if (!active || active.status !== 'RUNNING' || Number(active.attempt_number) !== Number(current.attempt_count) || current.state !== 'RUNNING') {
        await client.query('commit');
        return { executed: false, job: mapJob(current) };
      }
      scope = new ActiveJobAttemptScope(id, attemptId, Number(active.attempt_number), client);
      const value = await action(scope);
      await client.query("update job_attempts set status = 'SUCCEEDED', finished_at = now() where id = $1", [attemptId]);
      const updated = await client.query("update jobs set state = 'SUCCEEDED', result = $2, lease_owner = null, lease_expires_at = null, updated_at = now() where id = $1 returning *", [id, value]);
      await client.query('insert into job_events (job_id, event_type, details) values ($1, $2, $3)', [id, 'job.succeeded', { attemptId }]);
      await client.query('commit');
      return { executed: true, value, job: mapJob(updated.rows[0] as Record<string, unknown>) };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { scope?.close(); client.release(); }
  }

  async cancelAttempt(id: string, attemptId: string, action?: (scope: JobAttemptScope) => Promise<void>): Promise<JobRecord> {
    const client = await this.db.connect();
    let scope: ActiveJobAttemptScope | null = null;
    try {
      await client.query('begin');
      const selected = await client.query('select * from jobs where id = $1 for update', [id]);
      const current = selected.rows[0] as Record<string, unknown> | undefined;
      if (!current) throw new Error(`Job ${id} not found`);
      const attempt = await client.query<{ attempt_number: number; status: string }>('select attempt_number, status from job_attempts where id = $1 and job_id = $2', [attemptId, id]);
      const active = attempt.rows[0];
      if (!active || active.status !== 'RUNNING' || Number(active.attempt_number) !== Number(current.attempt_count) || current.state !== 'CANCEL_REQUESTED') {
        await client.query('commit');
        return mapJob(current);
      }
      if (action) {
        scope = new ActiveJobAttemptScope(id, attemptId, Number(active.attempt_number), client);
        await action(scope);
      }
      await client.query("update job_attempts set status = 'CANCELLED', finished_at = now() where id = $1", [attemptId]);
      const updated = await client.query("update jobs set state = 'CANCELLED', retry_at = null, lease_owner = null, lease_expires_at = null, updated_at = now() where id = $1 returning *", [id]);
      await client.query('insert into job_events (job_id, event_type, details) values ($1, $2, $3)', [id, 'job.cancelled', { attemptId }]);
      await client.query('commit');
      return mapJob(updated.rows[0] as Record<string, unknown>);
    } catch (error) { await client.query('rollback'); throw error; }
    finally { scope?.close(); client.release(); }
  }

  async reconcileExpiredLeases(now = new Date(), cancel?: JobLeaseCancellationHandler): Promise<number> {
    const expired = await this.db.query<{ id: string }>("select id from jobs where state in ('RUNNING','CANCEL_REQUESTED') and lease_expires_at < $1 order by id", [now]);
    let recovered = 0;
    for (const row of expired.rows) {
      try { if (await this.reconcileExpiredLease(row.id, now, cancel)) recovered += 1; }
      catch {
        try { await this.db.query('insert into job_events (job_id, event_type, details) values ($1, $2, $3)', [row.id, 'job.lease_recovery_failed', { code: 'LEASE_RECOVERY_FAILED' }]); }
        catch { /* preserve isolation when diagnostics persistence is also unavailable */ }
      }
    }
    return recovered;
  }

  private async reconcileExpiredLease(id: string, now: Date, cancel?: JobLeaseCancellationHandler): Promise<boolean> {
    const client = await this.db.connect();
    let scope: ActiveJobAttemptScope | null = null;
    try {
      await client.query('begin');
      const selected = await client.query("select * from jobs where id = $1 and state in ('RUNNING','CANCEL_REQUESTED') and lease_expires_at < $2 for update", [id, now]);
      const row = selected.rows[0] as Record<string, unknown> | undefined;
      if (!row) { await client.query('commit'); return false; }
      const attempt = await client.query<{ id: string; attempt_number: number }>("select id, attempt_number from job_attempts where job_id = $1 and status = 'RUNNING' order by attempt_number desc limit 1", [id]);
      const active = attempt.rows[0];
      if (!active) { await client.query('commit'); return false; }
      const cancelled = row.state === 'CANCEL_REQUESTED';
      if (cancelled) {
        if (!cancel) { await client.query('commit'); return false; }
        scope = new ActiveJobAttemptScope(id, active.id, Number(active.attempt_number), client);
        if (!(await cancel(mapJob(row), scope))) { await client.query('commit'); return false; }
      }
      await client.query("update job_attempts set status = $2, error = case when $2 = 'FAILED' then '{\"code\":\"LEASE_EXPIRED\"}'::jsonb else error end, finished_at = now() where id = $1", [active.id, cancelled ? 'CANCELLED' : 'FAILED']);
      await client.query("update jobs set state = $2, lease_owner = null, lease_expires_at = null, retry_at = case when $2 = 'RETRY_WAIT' then now() else null end, updated_at = now() where id = $1", [id, cancelled ? 'CANCELLED' : 'RETRY_WAIT']);
      await client.query('insert into job_events (job_id, event_type, details) values ($1, $2, $3)', [id, cancelled ? 'job.cancelled' : 'job.lease_recovered', {}]);
      await client.query('commit');
      return true;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { scope?.close(); client.release(); }
  }

  async attempts(jobId: string): Promise<Array<{ id: string; status: string; attempt_number: number }>> {
    const result = await this.db.query('select id, status, attempt_number from job_attempts where job_id = $1 order by attempt_number', [jobId]);
    return result.rows as Array<{ id: string; status: string; attempt_number: number }>;
  }
}

export class JobRunner {
  constructor(private readonly service: JobService, private readonly workerId: string, private readonly leaseMs = 30_000) {}
  async run(id: string, handler: (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown>): Promise<JobRecord> {
    const existing = await this.service.get(id);
    if (existing?.state === 'SUCCEEDED' || existing?.state === 'FAILED' || existing?.state === 'CANCELLED') return existing;
    const claimed = await this.service.claim(id, this.workerId, this.leaseMs);
    if (!claimed) return (await this.service.get(id)) as JobRecord;
    const controller = new AbortController();
    let renewal: Promise<void> | null = null;
    let heartbeatState: JobHeartbeat | 'ERROR' = 'ACTIVE';
    const pulse = async (): Promise<JobHeartbeat | 'ERROR'> => {
      try { heartbeatState = await this.service.heartbeat(id, claimed.attemptId, this.leaseMs); }
      catch { heartbeatState = 'ERROR'; }
      if (heartbeatState !== 'ACTIVE' && !controller.signal.aborted) controller.abort(new DOMException(`Job attempt heartbeat is ${heartbeatState}`, 'AbortError'));
      return heartbeatState;
    };
    const timer = setInterval(() => {
      if (renewal) return;
      renewal = pulse().then(() => undefined).finally(() => { renewal = null; });
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    timer.unref();
    try {
      const result = await handler(claimed.job, claimed.attemptId, controller.signal);
      const state = await pulse();
      if (state === 'CANCEL_REQUESTED') return this.service.cancelAttempt(id, claimed.attemptId);
      if (state === 'STALE') return (await this.service.get(id)) as JobRecord;
      if (state === 'ERROR') throw Object.assign(new Error('Job heartbeat failed'), { code: 'HEARTBEAT_FAILED', retryable: true });
      return await this.service.succeed(id, claimed.attemptId, result);
    }
    catch (error) {
      const state = heartbeatState === 'ACTIVE' ? await pulse() : heartbeatState;
      if (state === 'CANCEL_REQUESTED') return this.service.cancelAttempt(id, claimed.attemptId);
      if (state === 'STALE') return (await this.service.get(id)) as JobRecord;
      const candidate = error as { code?: unknown; retryable?: unknown };
      const retryable = typeof candidate.retryable === 'boolean' ? candidate.retryable : true;
      const code = typeof candidate.code === 'string' ? candidate.code : 'HANDLER_FAILED';
      return this.service.fail(id, claimed.attemptId, { code, message: error instanceof Error ? error.message : 'unknown' }, retryable);
    } finally { clearInterval(timer); if (renewal) await renewal; }
  }
}
