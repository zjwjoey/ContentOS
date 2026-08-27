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
    assert.equal(await service.reconcileExpiredLeases(new Date(Date.now() + 2_000)), 0);
    assert.equal((await service.get('job-integration-cancel'))?.state, 'CANCEL_REQUESTED');
    await service.reconcileExpiredLeases(new Date(Date.now() + 2_000), async () => true);
    const recovered = await service.get('job-integration-cancel');
    assert.equal(recovered?.state, 'CANCELLED');
    assert.ok(recovered?.leaseExpiresAt === null);
    assert.equal((await service.attempts('job-integration-cancel'))[0]?.status, 'CANCELLED');
  } finally { await db.end(); }
});

test('lease cancellation callback only closes Job types it explicitly handles', async () => {
  const db = await setup();
  try {
    const service = new JobService(db);
    for (const [id, type] of [['job-integration-cancel-handled', 'VIDEO_RENDER'], ['job-integration-cancel-unhandled', 'PUBLISH']] as const) {
      await service.create({ id, type, projectId: null, payload: {}, idempotencyKey: id, maxAttempts: 3 });
      await service.claim(id, 'worker-crashed', 1);
      await service.requestCancel(id);
    }
    const recovered = await service.reconcileExpiredLeases(new Date(Date.now() + 2_000), async (job) => job.type === 'VIDEO_RENDER');
    assert.equal(recovered, 1);
    assert.equal((await service.get('job-integration-cancel-handled'))?.state, 'CANCELLED');
    assert.equal((await service.get('job-integration-cancel-unhandled'))?.state, 'CANCEL_REQUESTED');
  } finally { await db.end(); }
});

test('one poisoned cancellation recovery does not block unrelated expired Jobs', async () => {
  const db = await setup();
  try {
    const service = new JobService(db);
    for (const id of ['job-integration-cancel-poison-a', 'job-integration-cancel-poison-b']) {
      await service.create({ id, type: 'VIDEO_RENDER', projectId: null, payload: {}, idempotencyKey: id, maxAttempts: 3 });
      await service.claim(id, 'worker-crashed', 1);
      await service.requestCancel(id);
    }
    const recovered = await service.reconcileExpiredLeases(new Date(Date.now() + 2_000), async (job) => {
      if (job.id.endsWith('-a')) throw new Error('poisoned recovery');
      return true;
    });
    assert.equal(recovered, 1);
    assert.equal((await service.get('job-integration-cancel-poison-a'))?.state, 'CANCEL_REQUESTED');
    assert.equal((await service.get('job-integration-cancel-poison-b'))?.state, 'CANCELLED');
    assert.equal((await db.query("select 1 from job_events where job_id = 'job-integration-cancel-poison-a' and event_type = 'job.lease_recovery_failed'")).rowCount, 1);
  } finally { await db.end(); }
});

test('current-attempt fence rejects expired work before a replacement attempt starts', async () => {
  const db = await setup();
  try {
    const service = new JobService(db);
    await service.create({ id: 'job-integration-fence-window', type: 'VIDEO_RENDER', projectId: null, payload: {}, idempotencyKey: 'job-integration-fence-window', maxAttempts: 3 });
    const expired = await service.claim('job-integration-fence-window', 'worker-expired', 1);
    assert.ok(expired);
    await service.reconcileExpiredLeases(new Date(Date.now() + 2_000));

    let sideEffects = 0;
    const fenced = await service.withCurrentAttemptFence('job-integration-fence-window', expired.attemptId, async () => {
      sideEffects += 1;
      return 'must-not-run';
    });

    assert.equal(fenced.executed, false);
    assert.equal(sideEffects, 0);
    assert.equal((await service.get('job-integration-fence-window'))?.state, 'RETRY_WAIT');
  } finally { await db.end(); }
});

test('four concurrent attempt fences reuse their locked connection without pool starvation', async () => {
  const db = await setup();
  try {
    const service = new JobService(db);
    const claims = [];
    for (let index = 0; index < 4; index += 1) {
      const id = `job-integration-pool-fence-${index}`;
      await service.create({ id, type: 'VIDEO_RENDER', projectId: null, payload: {}, idempotencyKey: id, maxAttempts: 3 });
      const claim = await service.claim(id, `worker-${index}`, 30_000);
      assert.ok(claim);
      claims.push({ id, attemptId: claim.attemptId });
    }
    const completed = Promise.all(claims.map(({ id, attemptId }) => service.withCurrentAttemptFence(id, attemptId, async (scope) => {
      await scope.query('select pg_sleep(0.05)');
      return id;
    })));
    const results = await Promise.race([completed, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('attempt fence pool starvation')), 2_000))]);
    assert.equal(results.every((result) => result.executed), true);
  } finally { await db.end(); }
});

test('current-attempt success rolls back its side effects when finalization fails', async () => {
  const db = await setup();
  try {
    const service = new JobService(db);
    const id = 'job-integration-atomic-finalize';
    await service.create({ id, type: 'VIDEO_RENDER', projectId: null, payload: {}, idempotencyKey: id, maxAttempts: 3 });
    const claimed = await service.claim(id, 'worker-atomic', 30_000);
    assert.ok(claimed);
    await assert.rejects(service.succeedWithCurrentAttempt(id, claimed.attemptId, async (scope) => {
      await scope.query('insert into job_events (job_id, event_type, details) values ($1, $2, $3)', [id, 'test.side_effect', {}]);
      throw new Error('finalization failed');
    }), /finalization failed/);
    assert.equal((await service.get(id))?.state, 'RUNNING');
    assert.equal((await service.attempts(id))[0]?.status, 'RUNNING');
    assert.equal((await db.query("select 1 from job_events where job_id = $1 and event_type = 'test.side_effect'", [id])).rowCount, 0);
  } finally { await db.end(); }
});

test('JobRunner aborts active work and persists cancellation without retry', async () => {
  const db = await setup();
  try {
    const service = new JobService(db);
    const runner = new JobRunner(service, 'worker-cancel', 90);
    await service.create({ id: 'job-integration-runner-cancel', type: 'VIDEO_RENDER', projectId: null, payload: {}, idempotencyKey: 'job-integration-runner-cancel', maxAttempts: 3 });
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    const running = runner.run('job-integration-runner-cancel', async (_job, _attemptId, signal) => {
      handlerStarted();
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return { unreachable: true };
    });
    await started;
    await service.requestCancel('job-integration-runner-cancel');

    const result = await running;
    assert.equal(result.state, 'CANCELLED');
    assert.equal((await service.attempts('job-integration-runner-cancel'))[0]?.status, 'CANCELLED');
  } finally { await db.end(); }
});

test('an expired Job attempt cannot overwrite the current attempt result', async () => {
  const db = await setup();
  try {
    const service = new JobService(db);
    await service.create({ id: 'job-integration-fenced', type: 'VIDEO_RENDER', projectId: null, payload: {}, idempotencyKey: 'job-integration-fenced', maxAttempts: 3 });
    const expired = await service.claim('job-integration-fenced', 'worker-expired', 1);
    assert.ok(expired);
    await service.reconcileExpiredLeases(new Date(Date.now() + 2_000));
    const current = await service.claim('job-integration-fenced', 'worker-current', 30_000);
    assert.ok(current);

    const staleSuccess = await service.succeed('job-integration-fenced', expired.attemptId, { output: 'stale' });
    assert.equal(staleSuccess.state, 'RUNNING');
    assert.equal(staleSuccess.attemptCount, 2);

    const succeeded = await service.succeed('job-integration-fenced', current.attemptId, { output: 'current' });
    assert.equal(succeeded.state, 'SUCCEEDED');
    const staleFailure = await service.fail('job-integration-fenced', expired.attemptId, { code: 'STALE' }, true);
    assert.equal(staleFailure.state, 'SUCCEEDED');
    assert.deepEqual(staleFailure.result, { output: 'current' });
  } finally { await db.end(); }
});

test('JobRunner renews a short lease while its handler is still running', async () => {
  const db = await setup();
  try {
    const service = new JobService(db);
    const runner = new JobRunner(service, 'worker-heartbeat', 180);
    await service.create({ id: 'job-integration-heartbeat', type: 'VIDEO_RENDER', projectId: null, payload: {}, idempotencyKey: 'job-integration-heartbeat', maxAttempts: 3 });
    let finish!: () => void;
    const handlerGate = new Promise<void>((resolve) => { finish = resolve; });
    const running = runner.run('job-integration-heartbeat', async () => { await handlerGate; return { ok: true }; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const firstLease = (await service.get('job-integration-heartbeat'))?.leaseExpiresAt;
    assert.ok(firstLease);
    assert.ok(firstLease.getTime() - Date.now() < 1_000);
    const renewalDeadline = Date.now() + 1_000;
    let renewedLease = firstLease;
    while (renewedLease.getTime() <= firstLease.getTime() && Date.now() < renewalDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      renewedLease = (await service.get('job-integration-heartbeat'))?.leaseExpiresAt || renewedLease;
    }
    assert.ok(renewedLease);
    assert.ok(renewedLease.getTime() > firstLease.getTime());
    assert.equal(await service.reconcileExpiredLeases(new Date()), 0);
    finish();
    assert.equal((await running).state, 'SUCCEEDED');
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
