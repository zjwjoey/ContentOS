import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { MEDIA_ANALYSIS, MediaIntelligenceService, createFakeIntelligenceProviders, type IntelligenceProviders } from '../../packages/modules/intelligence/src/index.js';
import { createMediaIntelligenceWorker } from '../../workers/media-intelligence-worker/src/main.js';

const databaseUrl = process.env.CONTENTOS_TEST_DATABASE_URL;

async function fixture(providers: IntelligenceProviders) {
  assert.ok(databaseUrl, 'an explicit isolated contentos_test URL is required');
  assert.equal(new URL(databaseUrl).pathname, '/contentos_test');
  const admin = await createDatabase(databaseUrl);
  const identity = await admin.query<{ name: string }>('select current_database() as name');
  assert.equal(identity.rows[0]?.name, 'contentos_test');
  const schema = `contentos_cancel_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`);
  await admin.end();
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const db = await createDatabase(scopedUrl.toString());
  await migrateUp(db);
  const project = await new ProjectService(db).create(`Queued cancellation ${randomUUID()}`);
  const assetId = `asset-cancel-${randomUUID()}`;
  await db.query('insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [assetId, project.id, 'VIDEO', `checksum-${assetId}`, 1, `fixtures/${assetId}.mp4`, 'READY', { durationMs: 1_000, width: 640, height: 360, fps: 30, hasAudio: false }]);
  const intelligence = new MediaIntelligenceService(db, providers);
  const run = await intelligence.createRun({ projectId: project.id, assetId, capabilities: ['TECHNICAL', 'SHOTS'] });
  const jobs = new JobService(db);
  const jobId = `job-media-cancel-${randomUUID()}`;
  await jobs.create({ id: jobId, type: MEDIA_ANALYSIS, projectId: project.id, payload: { schemaVersion: 'MEDIA_ANALYSIS_JOB_V1', projectId: project.id, assetId, runId: run.id, correlationId: `cancel-${run.id}` }, idempotencyKey: jobId, maxAttempts: 3 });
  await intelligence.attachJob(run.id, jobId);
  const close = async () => { try { await db.query(`drop schema "${schema}" cascade`); } finally { await db.end(); } };
  return { db, projectId: project.id, intelligence, jobs, runId: run.id, jobId, close };
}

test('QUEUED media analysis cancellation propagates idempotently before any provider call', async () => {
  const providers = createFakeIntelligenceProviders();
  let providerCalls = 0;
  const probe = providers.technical.probe.bind(providers.technical);
  providers.technical.probe = async (input) => { providerCalls += 1; return probe(input); };
  const f = await fixture(providers);
  const worker = createMediaIntelligenceWorker(f, { pollIntervalMs: 60_000, reconcileIntervalMs: 60_000 });
  try {
    await f.jobs.requestCancel(f.jobId);
    await f.jobs.requestCancel(f.jobId);
    await worker.start();
    await worker.shutdown('TEST');
    const first = await f.intelligence.getRun(f.projectId, f.runId);
    assert.equal((await f.jobs.get(f.jobId))?.state, 'CANCELLED');
    assert.equal(providerCalls, 0);
    assert.deepEqual(await f.jobs.attempts(f.jobId), []);
    assert.ok(first);
    assert.equal(first?.status, 'CANCELLED');
    assert.ok(first.finishedAt);
    assert.equal(first.error?.code, 'MEDIA_ANALYSIS_JOB_CANCELLED');

    const restarted = createMediaIntelligenceWorker(f, { pollIntervalMs: 60_000, reconcileIntervalMs: 60_000 });
    try { await restarted.start(); } finally { await restarted.shutdown('TEST'); }
    const second = await f.intelligence.getRun(f.projectId, f.runId);
    assert.ok(second);
    assert.equal(second?.status, 'CANCELLED');
    assert.equal(second.finishedAt, first.finishedAt);
    assert.deepEqual(second.error, first.error);
    assert.equal(providerCalls, 0);
    assert.deepEqual(await f.jobs.attempts(f.jobId), []);
  } finally { await worker.shutdown('TEST'); await f.close(); }
});

test('cancelled queued Job reconciliation preserves completed analysis results', async () => {
  const f = await fixture(createFakeIntelligenceProviders());
  try {
    const completed = await f.intelligence.analyzeRun(f.runId);
    assert.equal(completed.status, 'SUCCEEDED');
    const before = await f.db.query('select status,finished_at,error from media_analysis_runs where id=$1', [f.runId]);
    const resultsBefore = await f.intelligence.results(f.projectId, f.runId);
    await f.jobs.requestCancel(f.jobId);
    await f.jobs.requestCancel(f.jobId);
    assert.equal(await f.intelligence.reconcileStaleRuns(), 0);
    assert.equal(await f.intelligence.reconcileStaleRuns(), 0);
    assert.deepEqual((await f.db.query('select status,finished_at,error from media_analysis_runs where id=$1', [f.runId])).rows, before.rows);
    assert.deepEqual(await f.intelligence.results(f.projectId, f.runId), resultsBefore);
  } finally { await f.close(); }
});

test('cancellation reconciliation preserves a newly claimed active analysis attempt', async () => {
  const providers = createFakeIntelligenceProviders();
  const probe = providers.technical.probe.bind(providers.technical);
  let releaseProbe!: () => void;
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseProbe = resolve; });
  providers.technical.probe = async (input) => { signalEntered(); await blocked; return probe(input); };
  const f = await fixture(providers);
  let running: ReturnType<MediaIntelligenceService['analyzeRun']> | undefined;
  try {
    await f.jobs.requestCancel(f.jobId);
    const cancelledSnapshot = await f.jobs.get(f.jobId);
    assert.equal(cancelledSnapshot?.state, 'CANCELLED');
    await f.jobs.requeueTerminal(f.jobId);
    const current = await f.jobs.claim(f.jobId, 'new-analysis-attempt', 30_000);
    assert.ok(current);
    running = f.intelligence.analyzeRun(f.runId);
    await Promise.race([entered, running.then(() => { throw new Error('Analysis finished before the controlled provider entered'); })]);
    assert.equal((await f.intelligence.getRun(f.projectId, f.runId))?.status, 'RUNNING');
    assert.equal(await f.intelligence.reconcileStaleRuns(), 0);
    assert.equal((await f.intelligence.getRun(f.projectId, f.runId))?.status, 'RUNNING');
    assert.equal((await f.jobs.get(f.jobId))?.attemptCount, current.job.attemptCount);
    assert.equal((await f.jobs.get(f.jobId))?.state, 'RUNNING');
    releaseProbe();
    assert.equal((await running).status, 'SUCCEEDED');
  } finally {
    releaseProbe();
    if (running) await running.catch(() => undefined);
    await f.close();
  }
});
