import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { JobService, JobRunner } from '../../packages/modules/job/src/index.js';
import { PgBossDelivery } from '../../packages/infrastructure/queue/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

async function setup() {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  await db.query("delete from job_events where job_id like 'job-integration-%'");
  await db.query("delete from job_attempts where job_id like 'job-integration-%'");
  await db.query("delete from jobs where id like 'job-integration-%'");
  return db;
}

test('Job idempotent creation returns one record for concurrent duplicate requests', async () => {
  const db = await setup();
  try {
    const service = new JobService(db);
    const input = { type: 'PUBLISH', projectId: null, payload: { value: 1 }, idempotencyKey: 'job-integration-idempotent', maxAttempts: 3 };
    const [first, second] = await Promise.all([
      service.createIdempotent({ ...input, id: 'job-integration-idempotent-a' }),
      service.createIdempotent({ ...input, id: 'job-integration-idempotent-b' }),
    ]);
    assert.equal(first.id, second.id);
    const rows = await db.query('select id from jobs where idempotency_key = $1', [input.idempotencyKey]);
    assert.equal(rows.rowCount, 1);
  } finally { await db.end(); }
});

test('Job claim, attempt history, success and duplicate delivery are idempotent', async () => {
  const db = await setup();
  try {
    const service = new JobService(db);
    const runner = new JobRunner(service, 'worker-test');
    await service.create({ id: 'job-integration-success', type: 'video.render', projectId: null, payload: { value: 1 }, idempotencyKey: 'job-integration-success', maxAttempts: 3 });
    let executions = 0;
    assert.equal((await runner.run('job-integration-success', async () => { executions += 1; return { output: 'asset-1' }; })).state, 'SUCCEEDED');
    assert.equal((await runner.run('job-integration-success', async () => { executions += 1; return { output: 'duplicate' }; })).state, 'SUCCEEDED');
    assert.equal(executions, 1);
    const job = await service.get('job-integration-success');
    assert.equal(job?.state, 'SUCCEEDED');
    assert.equal(job?.attemptCount, 1);
  } finally { await db.end(); }
});

test('retryable failure retains attempt history and succeeds on the next attempt', async () => {
  const db = await setup();
  try {
    const service = new JobService(db);
    const runner = new JobRunner(service, 'worker-retry');
    await service.create({ id: 'job-integration-retry', type: 'video.render', projectId: null, payload: {}, idempotencyKey: 'job-integration-retry', maxAttempts: 3 });
    let calls = 0;
    const first = await runner.run('job-integration-retry', async () => { calls += 1; throw new Error('temporary'); });
    assert.equal(first.state, 'RETRY_WAIT');
    await service.requeue('job-integration-retry');
    const second = await runner.run('job-integration-retry', async () => { calls += 1; return { ok: true }; });
    assert.equal(second.state, 'SUCCEEDED');
    assert.equal(calls, 2);
    assert.equal((await service.attempts('job-integration-retry')).length, 2);
  } finally { await db.end(); }
});

test('cooperative cancellation is durable and lease reconciliation recovers crashed work', async () => {
  const db = await setup();
  try {
    const service = new JobService(db);
    await service.create({ id: 'job-integration-cancel', type: 'video.render', projectId: null, payload: {}, idempotencyKey: 'job-integration-cancel', maxAttempts: 3 });
    await service.claim('job-integration-cancel', 'worker-crashed', 1);
    await service.requestCancel('job-integration-cancel');
    const cancelState = await service.get('job-integration-cancel');
    assert.equal(cancelState?.state, 'CANCEL_REQUESTED');
    await service.reconcileExpiredLeases(new Date(Date.now() + 2_000));
    const recovered = await service.get('job-integration-cancel');
    assert.equal(recovered?.state, 'RETRY_WAIT');
    assert.ok(recovered?.leaseExpiresAt === null);
  } finally { await db.end(); }
});

test('runnable job query filters by type and retry readiness', async () => {
  const db = await setup();
  try {
    const service = new JobService(db);
    await service.create({ id: 'job-integration-runnable-director', type: 'DIRECTOR_GENERATE_SCRIPT', projectId: null, payload: {}, idempotencyKey: 'job-integration-runnable-director', maxAttempts: 3 });
    await service.create({ id: 'job-integration-runnable-video', type: 'VIDEO_RENDER', projectId: null, payload: {}, idempotencyKey: 'job-integration-runnable-video', maxAttempts: 3 });
    const directorJobs = await service.listRunnable(['DIRECTOR_GENERATE_SCRIPT']);
    assert.ok(directorJobs.some((job) => job.id === 'job-integration-runnable-director'));
    assert.ok(directorJobs.every((job) => job.type === 'DIRECTOR_GENERATE_SCRIPT'));
    assert.ok((await service.listRunnable(['DIRECTOR_GENERATE_STORYBOARD'])).every((job) => job.type === 'DIRECTOR_GENERATE_STORYBOARD'));
  } finally { await db.end(); }
});

test('pg-boss is a delivery adapter over the database Job contract', async () => {
  const delivery = new PgBossDelivery(databaseUrl);
  await delivery.start();
  try {
    const id = await delivery.send('contentos.integration', { jobId: 'job-integration-delivery' });
    assert.equal(typeof id, 'string');
  } finally { await delivery.stop(); }
});
