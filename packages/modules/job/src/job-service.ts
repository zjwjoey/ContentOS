import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type JobState = 'QUEUED' | 'RUNNING' | 'RETRY_WAIT' | 'FAILED' | 'SUCCEEDED' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'BLOCKED';
export interface JobRecord { id: string; projectId: string | null; type: string; state: JobState; payload: unknown; result: unknown; error: unknown; attemptCount: number; maxAttempts: number; leaseOwner: string | null; leaseExpiresAt: Date | null; progress: unknown; }
export interface CreateJobInput { id: string; type: string; projectId: string | null; payload: unknown; idempotencyKey: string; maxAttempts: number; }

function mapJob(row: Record<string, unknown>): JobRecord {
  return { id: String(row.id), projectId: row.project_id ? String(row.project_id) : null, type: String(row.type), state: row.state as JobState, payload: row.payload, result: row.result, error: row.error, attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts), leaseOwner: row.lease_owner ? String(row.lease_owner) : null, leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)) : null, progress: row.progress };
}

export class JobService {
  constructor(private readonly db: Pool) {}

  async create(input: CreateJobInput): Promise<JobRecord> {
    const result = await this.db.query('insert into jobs (id, project_id, type, state, idempotency_key, payload, max_attempts) values ($1, $2, $3, $4, $5, $6, $7) returning *', [input.id, input.projectId, input.type, 'QUEUED', input.idempotencyKey, input.payload, input.maxAttempts]);
    return mapJob(result.rows[0] as Record<string, unknown>);
  }

  async get(id: string): Promise<JobRecord | null> {
    const result = await this.db.query('select * from jobs where id = $1', [id]);
    return result.rows[0] ? mapJob(result.rows[0] as Record<string, unknown>) : null;
  }

  async claim(id: string, workerId: string, leaseMs: number): Promise<{ job: JobRecord; attemptId: string } | null> {
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const selected = await client.query('select * from jobs where id = $1 for update', [id]);
      const row = selected.rows[0] as Record<string, unknown> | undefined;
      if (!row || !['QUEUED', 'RETRY_WAIT'].includes(String(row.state))) { await client.query('rollback'); return null; }
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
      await client.query('update job_attempts set status = $2, finished_at = now() where id = $1', [attemptId, 'SUCCEEDED']);
      const updated = await client.query('update jobs set state = $2, result = $3, lease_owner = null, lease_expires_at = null, updated_at = now() where id = $1 returning *', [id, 'SUCCEEDED', result]);
      await client.query('insert into job_events (job_id, event_type, details) values ($1, $2, $3)', [id, 'job.succeeded', { attemptId }]);
      await client.query('commit');
      return mapJob(updated.rows[0] as Record<string, unknown>);
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async fail(id: string, attemptId: string, error: unknown, retryable: boolean): Promise<JobRecord> {
    const current = await this.get(id);
    if (!current) throw new Error(`Job ${id} not found`);
    const retry = retryable && current.attemptCount < current.maxAttempts;
    const state: JobState = retry ? 'RETRY_WAIT' : 'FAILED';
    await this.db.query('update job_attempts set status = $2, error = $3, finished_at = now() where id = $1', [attemptId, 'FAILED', error]);
    const result = await this.db.query('update jobs set state = $2, error = $3, retry_at = case when $2 = \'RETRY_WAIT\' then now() + interval \'1 second\' else null end, lease_owner = null, lease_expires_at = null, updated_at = now() where id = $1 returning *', [id, state, error]);
    await this.db.query('insert into job_events (job_id, event_type, details) values ($1, $2, $3)', [id, retry ? 'job.retry_scheduled' : 'job.failed', { attemptId, retryable }]);
    return mapJob(result.rows[0] as Record<string, unknown>);
  }

  async requeue(id: string): Promise<void> { await this.db.query("update jobs set state = 'QUEUED', retry_at = null, updated_at = now() where id = $1 and state = 'RETRY_WAIT'", [id]); }

  async requestCancel(id: string): Promise<void> { await this.db.query("update jobs set state = case when state = 'QUEUED' then 'CANCELLED' else 'CANCEL_REQUESTED' end, updated_at = now() where id = $1 and state in ('QUEUED','RUNNING','RETRY_WAIT')", [id]); }

  async reconcileExpiredLeases(now = new Date()): Promise<number> {
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const expired = await client.query("select id from jobs where state in ('RUNNING','CANCEL_REQUESTED') and lease_expires_at < $1 for update", [now]);
      for (const row of expired.rows as Array<{ id: string }>) {
        await client.query("update job_attempts set status = 'FAILED', error = '{\"code\":\"LEASE_EXPIRED\"}', finished_at = now() where id = (select id from job_attempts where job_id = $1 and status = 'RUNNING' order by attempt_number desc limit 1)", [row.id]);
        await client.query("update jobs set state = 'RETRY_WAIT', lease_owner = null, lease_expires_at = null, retry_at = now(), updated_at = now() where id = $1", [row.id]);
        await client.query('insert into job_events (job_id, event_type, details) values ($1, $2, $3)', [row.id, 'job.lease_recovered', {}]);
      }
      await client.query('commit');
      return expired.rowCount || 0;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async attempts(jobId: string): Promise<Array<{ id: string; status: string; attempt_number: number }>> {
    const result = await this.db.query('select id, status, attempt_number from job_attempts where job_id = $1 order by attempt_number', [jobId]);
    return result.rows as Array<{ id: string; status: string; attempt_number: number }>;
  }
}

export class JobRunner {
  constructor(private readonly service: JobService, private readonly workerId: string) {}
  async run(id: string, handler: (job: JobRecord) => Promise<unknown>): Promise<JobRecord> {
    const existing = await this.service.get(id);
    if (existing?.state === 'SUCCEEDED' || existing?.state === 'FAILED' || existing?.state === 'CANCELLED') return existing;
    const claimed = await this.service.claim(id, this.workerId, 30_000);
    if (!claimed) return (await this.service.get(id)) as JobRecord;
    try { return await this.service.succeed(id, claimed.attemptId, await handler(claimed.job)); }
    catch (error) { return this.service.fail(id, claimed.attemptId, { code: 'HANDLER_FAILED', message: error instanceof Error ? error.message : 'unknown' }, true); }
  }
}
