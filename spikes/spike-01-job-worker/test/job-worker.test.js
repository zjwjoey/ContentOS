const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const {
  SpikeJobStore,
  SpikeWorker,
  createJob,
  waitForJob,
  requestCancel,
  closeSpike,
} = require('../src/job-worker');

const connectionString = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:55432/contentos_spike';

test.before(async () => {
  await SpikeJobStore.prepareDatabase(connectionString);
});

test.after(async () => {
  await closeSpike();
});

test('long job persists progress and succeeds through pg-boss delivery', async () => {
  const job = await createJob({ type: 'TEST_LONG_JOB', steps: 5, delayMs: 30 });
  const worker = new SpikeWorker({ connectionString, workerId: 'worker-normal' });
  await worker.start();
  await worker.enqueue(job.jobId);
  const result = await waitForJob(job.jobId);
  await worker.stop();

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.progress, 100);
  assert.equal(result.attempt, 1);
  assert.ok(result.transitions.includes('RUNNING'));
  assert.ok(result.transitions.includes('SUCCEEDED'));
});

test('retry history is retained and third attempt succeeds', async () => {
  const job = await createJob({ type: 'FAIL_TWICE_THEN_SUCCEED', failures: 2, maxAttempts: 3 });
  const worker = new SpikeWorker({ connectionString, workerId: 'worker-retry' });
  await worker.start();
  await worker.enqueue(job.jobId);
  const result = await waitForJob(job.jobId);
  await worker.stop();

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.attempt, 3);
  assert.deepEqual(result.attemptResults.map((entry) => entry.outcome), ['error', 'error', 'success']);
});

test('max attempts produce a terminal FAILED job', async () => {
  const job = await createJob({ type: 'ALWAYS_FAIL', maxAttempts: 3 });
  const worker = new SpikeWorker({ connectionString, workerId: 'worker-terminal' });
  await worker.start();
  await worker.enqueue(job.jobId);
  const result = await waitForJob(job.jobId);
  await worker.stop();

  assert.equal(result.status, 'FAILED');
  assert.equal(result.attempt, 3);
  assert.equal(result.attemptResults.length, 3);
});

test('cooperative cancellation reaches CANCELLED without false success', async () => {
  const job = await createJob({ type: 'TEST_LONG_JOB', steps: 30, delayMs: 25 });
  const worker = new SpikeWorker({ connectionString, workerId: 'worker-cancel' });
  await worker.start();
  await worker.enqueue(job.jobId);
  await waitForJob(job.jobId, { until: (current) => current.status === 'RUNNING' && current.progress >= 20 });
  await requestCancel(job.jobId);
  const result = await waitForJob(job.jobId);
  await worker.stop();

  assert.equal(result.status, 'CANCELLED');
  assert.ok(result.progress < 100);
});

test('duplicate delivery uses job idempotency and runs business work once', async () => {
  const job = await createJob({ type: 'TEST_LONG_JOB', steps: 3, delayMs: 20 });
  const worker = new SpikeWorker({ connectionString, workerId: 'worker-duplicate' });
  await worker.start();
  await Promise.all([worker.enqueue(job.jobId), worker.enqueue(job.jobId)]);
  const result = await waitForJob(job.jobId);
  await worker.stop();

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.businessExecutions, 1);
});

test('worker crash leaves RUNNING job recoverable by a new worker', async () => {
  const job = await createJob({ type: 'TEST_LONG_JOB', steps: 20, delayMs: 25 });
  const child = spawn(process.execPath, [path.join(__dirname, 'crash-worker-child.js')], {
    env: { ...process.env, DATABASE_URL: connectionString, SPIKE_JOB_ID: job.jobId },
    stdio: 'ignore',
  });
  const childExited = new Promise((resolve) => child.once('exit', resolve));
  await waitForJob(job.jobId, { timeoutMs: 10000, until: (current) => current.status === 'RUNNING' && current.progress >= 20 });
  child.kill('SIGKILL');
  await childExited;

  const recoveryWorker = new SpikeWorker({ connectionString, workerId: 'worker-recovery' });
  await recoveryWorker.start();
  const result = await waitForJob(job.jobId, { timeoutMs: 30000 });
  await recoveryWorker.stop();

  assert.equal(result.status, 'SUCCEEDED');
  assert.ok(result.attempt >= 2);
  assert.ok(result.transitions.filter((entry) => entry === 'RUNNING').length >= 2);
});
