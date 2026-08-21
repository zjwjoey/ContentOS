const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { PgBoss } = require('pg-boss');

const QUEUE = 'spike01_work';
const QUEUE_SCHEMA = 'spike01_queue';
const JOB_SCHEMA = 'spike01';
const POLL_MS = 40;
const WORKER_LEASE_MS = 5000;

let pool;
const bosses = new Set();
const workers = new Set();

function getPool(connectionString) {
  if (!pool) pool = new Pool({ connectionString, max: 8, application_name: 'contentos-spike-01' });
  return pool;
}

async function prepareSchema(connectionString) {
  const db = getPool(connectionString);
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${JOB_SCHEMA}`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${JOB_SCHEMA}.jobs (
      job_id uuid PRIMARY KEY,
      job_type text NOT NULL,
      status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','RETRY_WAIT','SUCCEEDED','FAILED','CANCEL_REQUESTED','CANCELLED')),
      payload jsonb NOT NULL,
      result jsonb,
      attempt integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL CHECK (max_attempts >= 1),
      progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      started_at timestamptz,
      finished_at timestamptz,
      last_error text,
      cancel_requested boolean NOT NULL DEFAULT false,
      lease_expires_at timestamptz,
      business_executions integer NOT NULL DEFAULT 0,
      transitions jsonb NOT NULL DEFAULT '[]'::jsonb,
      attempt_results jsonb NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${JOB_SCHEMA}.job_events (
      event_id bigserial PRIMARY KEY,
      job_id uuid NOT NULL REFERENCES ${JOB_SCHEMA}.jobs(job_id),
      event_type text NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
}

class SpikeJobStore {
  static async prepareDatabase(connectionString) {
    const db = getPool(connectionString);
    await db.query(`DROP SCHEMA IF EXISTS ${QUEUE_SCHEMA} CASCADE`);
    await prepareSchema(connectionString);
    await db.query(`TRUNCATE ${JOB_SCHEMA}.job_events, ${JOB_SCHEMA}.jobs RESTART IDENTITY`);
  }
}

async function connectSpike(connectionString) {
  await prepareSchema(connectionString);
}

async function createJob({ type, steps = 5, delayMs = 30, failures = 0, maxAttempts = 3 }) {
  if (!pool) throw new Error('SpikeJobStore.prepareDatabase must run first');
  const jobId = randomUUID();
  const payload = { steps, delayMs, failures };
  await pool.query(
    `INSERT INTO ${JOB_SCHEMA}.jobs (job_id, job_type, status, payload, max_attempts, transitions)
     VALUES ($1, $2, 'QUEUED', $3::jsonb, $4, '[]'::jsonb)`,
    [jobId, type, JSON.stringify(payload), maxAttempts],
  );
  await recordEvent(jobId, 'QUEUED', { jobType: type });
  return { jobId };
}

async function requestCancel(jobId) {
  const result = await pool.query(
    `UPDATE ${JOB_SCHEMA}.jobs
        SET cancel_requested = true,
            status = CASE WHEN status = 'QUEUED' THEN 'CANCELLED' ELSE 'CANCEL_REQUESTED' END
      WHERE job_id = $1
      RETURNING status`,
    [jobId],
  );
  if (result.rowCount && result.rows[0].status === 'CANCELLED') await recordEvent(jobId, 'CANCELLED', { reason: 'cancel-before-claim' });
}

async function recordEvent(jobId, eventType, details = {}) {
  await pool.query(
    `INSERT INTO ${JOB_SCHEMA}.job_events (job_id, event_type, details) VALUES ($1, $2, $3::jsonb)`,
    [jobId, eventType, JSON.stringify(details)],
  );
}

async function getJob(jobId) {
  const { rows } = await pool.query(
    `SELECT job_id AS "jobId", job_type AS "jobType", status, payload, result, attempt,
            max_attempts AS "maxAttempts", progress, created_at AS "createdAt",
            started_at AS "startedAt", finished_at AS "finishedAt", last_error AS "lastError",
            cancel_requested AS "cancelRequested", lease_expires_at AS "leaseExpiresAt",
            business_executions AS "businessExecutions", transitions, attempt_results AS "attemptResults"
       FROM ${JOB_SCHEMA}.jobs WHERE job_id = $1`,
    [jobId],
  );
  if (!rows[0]) return null;
  const events = await pool.query(
    `SELECT event_type FROM ${JOB_SCHEMA}.job_events WHERE job_id = $1 ORDER BY event_id`,
    [jobId],
  );
  return { ...rows[0], transitions: events.rows.map((row) => row.event_type), attemptResults: rows[0].attemptResults || [] };
}

async function waitForJob(jobId, { timeoutMs = 30000, until } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await getJob(jobId);
    if (current && (until ? until(current) : ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(current.status))) return current;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

class SpikeWorker {
  constructor({ connectionString, workerId, crashAfterProgress = null }) {
    this.connectionString = connectionString;
    this.workerId = workerId;
    this.crashAfterProgress = crashAfterProgress;
    this.boss = new PgBoss({
      connectionString,
      schema: QUEUE_SCHEMA,
      application_name: `contentos-spike-01-${workerId}`,
      supervise: true,
      superviseIntervalSeconds: 1,
    });
    this.boss.on('error', (error) => console.error(JSON.stringify({ event: 'queue.error', workerId, error: error.message })));
    bosses.add(this.boss);
    workers.add(this);
    this.workId = null;
    this.superviseTimer = null;
    this.recoveryTimer = null;
  }

  async start() {
    await this.boss.start();
    await this.boss.createQueue(QUEUE, {
      retryLimit: 0,
      retryDelay: 0,
      expireInSeconds: 2,
      deleteAfterSeconds: 0,
    });
    this.workId = await this.boss.work(QUEUE, { batchSize: 1, heartbeatRefreshSeconds: 1 }, async ([message]) => {
      await this.handleMessage(message.data.jobId);
    });
    this.superviseTimer = setInterval(() => {
      this.boss.supervise(QUEUE).catch((error) => console.error(JSON.stringify({ event: 'queue.supervise_error', workerId: this.workerId, error: error.message })));
    }, 500);
    this.recoveryTimer = setInterval(() => {
      this.recoverExpiredJobs().catch((error) => console.error(JSON.stringify({ event: 'job.recovery_error', workerId: this.workerId, error: error.message })));
    }, 500);
  }

  async enqueue(jobId) {
    const job = await getJob(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}`);
    const retryLimit = Math.max(0, job.maxAttempts - 1);
    return this.boss.send(QUEUE, { jobId }, { retryLimit, retryDelay: 0, expireInSeconds: 2, deleteAfterSeconds: 0 });
  }

  async handleMessage(jobId) {
    const claimed = await this.claim(jobId);
    if (!claimed) return;
    const { job, attempt } = claimed;
    try {
      if (job.jobType === 'FAIL_TWICE_THEN_SUCCEED' || job.jobType === 'ALWAYS_FAIL') {
        await this.recordBusinessExecution(jobId, attempt);
        const shouldFail = job.jobType === 'ALWAYS_FAIL' || attempt <= job.payload.failures;
        if (shouldFail) {
          await this.failAttempt(jobId, attempt, `intentional failure at attempt ${attempt}`);
          if (attempt >= job.maxAttempts) return;
          throw new Error(`retryable failure at attempt ${attempt}`);
        }
        await this.succeed(jobId, attempt, { outcome: 'success' });
        return;
      }

      await this.recordBusinessExecution(jobId, attempt);
      const steps = Number(job.payload.steps || 1);
      for (let step = 1; step <= steps; step += 1) {
        await new Promise((resolve) => setTimeout(resolve, Number(job.payload.delayMs || 0)));
        const current = await getJob(jobId);
        if (current.cancelRequested || current.status === 'CANCEL_REQUESTED') {
          await this.cancelled(jobId, attempt, step, steps);
          return;
        }
        const progress = Math.floor((step / steps) * 100);
        await pool.query(
          `UPDATE ${JOB_SCHEMA}.jobs SET progress = $2, lease_expires_at = clock_timestamp() + ($3 || ' milliseconds')::interval WHERE job_id = $1`,
          [jobId, progress, WORKER_LEASE_MS],
        );
        await recordEvent(jobId, 'PROGRESS', { attempt, progress, workerId: this.workerId });
        if (this.crashAfterProgress !== null && progress >= this.crashAfterProgress) {
          process.kill(process.pid, 'SIGKILL');
        }
      }
      await this.succeed(jobId, attempt, { outcome: 'success' });
    } catch (error) {
      if (error?.code === '57P01') throw error;
      throw error;
    }
  }

  async recoverExpiredJobs() {
    const { rows } = await pool.query(
      `SELECT job_id AS "jobId" FROM ${JOB_SCHEMA}.jobs
        WHERE status IN ('RUNNING','CANCEL_REQUESTED')
          AND lease_expires_at < clock_timestamp()`,
    );
    for (const row of rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const moved = await client.query(
          `UPDATE ${JOB_SCHEMA}.jobs
              SET status = 'RETRY_WAIT', lease_expires_at = NULL,
                  last_error = 'worker lease expired; reconciled'
            WHERE job_id = $1
              AND status IN ('RUNNING','CANCEL_REQUESTED')
              AND lease_expires_at < clock_timestamp()`,
          [row.jobId],
        );
        await client.query('COMMIT');
        if (moved.rowCount) {
          await recordEvent(row.jobId, 'LEASE_RECOVERED', { workerId: this.workerId });
          await this.enqueue(row.jobId);
        }
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async claim(jobId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT * FROM ${JOB_SCHEMA}.jobs
          WHERE job_id = $1
            AND (status = 'QUEUED' OR status = 'RETRY_WAIT' OR (status IN ('RUNNING','CANCEL_REQUESTED') AND lease_expires_at < clock_timestamp()))
          FOR UPDATE SKIP LOCKED`,
        [jobId],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const attempt = rows[0].attempt + 1;
      const { rows: updated } = await client.query(
        `UPDATE ${JOB_SCHEMA}.jobs
            SET status = 'RUNNING', attempt = $2, started_at = COALESCE(started_at, clock_timestamp()),
                lease_expires_at = clock_timestamp() + ($3 || ' milliseconds')::interval,
                last_error = NULL
          WHERE job_id = $1 RETURNING *`,
        [jobId, attempt, WORKER_LEASE_MS],
      );
      await client.query(
        `INSERT INTO ${JOB_SCHEMA}.job_events (job_id, event_type, details) VALUES ($1, 'RUNNING', $2::jsonb)`,
        [jobId, JSON.stringify({ attempt, workerId: this.workerId })],
      );
      await client.query('COMMIT');
      const claimedRow = updated[0];
      return {
        job: {
          jobId: claimedRow.job_id,
          jobType: claimedRow.job_type,
          payload: claimedRow.payload,
          maxAttempts: claimedRow.max_attempts,
          attempt: claimedRow.attempt,
          cancelRequested: claimedRow.cancel_requested,
        },
        attempt,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordBusinessExecution(jobId, attempt) {
    await pool.query(`UPDATE ${JOB_SCHEMA}.jobs SET business_executions = business_executions + 1 WHERE job_id = $1`, [jobId]);
    await recordEvent(jobId, 'BUSINESS_EXECUTION', { attempt, workerId: this.workerId });
  }

  async failAttempt(jobId, attempt, message) {
    await pool.query(
      `UPDATE ${JOB_SCHEMA}.jobs
          SET status = CASE WHEN attempt >= max_attempts THEN 'FAILED' ELSE 'RETRY_WAIT' END,
              last_error = $2,
              attempt_results = attempt_results || $3::jsonb,
              finished_at = CASE WHEN attempt >= max_attempts THEN clock_timestamp() ELSE NULL END,
              lease_expires_at = NULL
        WHERE job_id = $1`,
      [jobId, message, JSON.stringify([{ attempt, outcome: 'error', error: message }])],
    );
    await recordEvent(jobId, 'FAILED_ATTEMPT', { attempt, error: message });
  }

  async succeed(jobId, attempt, result) {
    await pool.query(
      `UPDATE ${JOB_SCHEMA}.jobs
          SET status = 'SUCCEEDED', progress = 100, result = $2::jsonb,
              attempt_results = attempt_results || $3::jsonb,
              finished_at = clock_timestamp(), lease_expires_at = NULL
        WHERE job_id = $1 AND status = 'RUNNING'`,
      [jobId, JSON.stringify(result), JSON.stringify([{ attempt, outcome: 'success' }])],
    );
    await recordEvent(jobId, 'SUCCEEDED', { attempt, workerId: this.workerId });
  }

  async cancelled(jobId, attempt, step, steps) {
    await pool.query(
      `UPDATE ${JOB_SCHEMA}.jobs
          SET status = 'CANCELLED', finished_at = clock_timestamp(), lease_expires_at = NULL,
              last_error = 'cooperative cancellation',
              attempt_results = attempt_results || $2::jsonb
        WHERE job_id = $1`,
      [jobId, JSON.stringify([{ attempt, outcome: 'cancelled', step, steps }])],
    );
    await recordEvent(jobId, 'CANCELLED', { attempt, step, steps, workerId: this.workerId });
  }

  async stop() {
    if (this.superviseTimer) clearInterval(this.superviseTimer);
    this.superviseTimer = null;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    if (this.workId) await this.boss.offWork(QUEUE, { id: this.workId });
    await this.boss.stop();
    bosses.delete(this.boss);
    workers.delete(this);
  }
}

async function closeSpike() {
  for (const worker of [...workers]) {
    if (worker.superviseTimer) clearInterval(worker.superviseTimer);
    worker.superviseTimer = null;
    if (worker.recoveryTimer) clearInterval(worker.recoveryTimer);
    worker.recoveryTimer = null;
  }
  for (const boss of [...bosses]) {
    try { await boss.stop(); } catch { /* best-effort test cleanup */ }
  }
  bosses.clear();
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = {
  SpikeJobStore,
  SpikeWorker,
  connectSpike,
  createJob,
  getJob,
  waitForJob,
  requestCancel,
  closeSpike,
};
