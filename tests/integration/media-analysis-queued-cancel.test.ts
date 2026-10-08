import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { JobService, type JobCancellationScope } from '../../packages/modules/job/src/index.js';
import { MEDIA_ANALYSIS, MediaIntelligenceService, createFakeIntelligenceProviders, type IntelligenceProviders } from '../../packages/modules/intelligence/src/index.js';
import { createMediaIntelligenceWorker } from '../../workers/media-intelligence-worker/src/main.js';

const databaseUrl = process.env.CONTENTOS_TEST_DATABASE_URL;

async function fixture(providers: IntelligenceProviders, poolSize = 4) {
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
  const db = new pg.Pool({ connectionString: scopedUrl.toString(), max: poolSize, connectionTimeoutMillis: 1_500 });
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
  return { db, projectId: project.id, assetId, intelligence, jobs, runId: run.id, jobId, close };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function expected(f: Fixture, attemptCount = 0) { return { type: MEDIA_ANALYSIS, projectId: f.projectId, attemptCount }; }
function cancelOwnedRun(f: Fixture, scope: JobCancellationScope) { return f.intelligence.markQueuedCancelledWithExecutor(scope, f.runId, f.jobId, f.projectId); }
async function waitBlocked(db: pg.Pool, blockerPid: number, queryPrefix: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await db.query<{ pid: number }>('select pid from pg_stat_activity where $1::integer = any(pg_blocking_pids(pid)) and left(query,length($2)) = $2', [blockerPid, queryPrefix]);
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('expected an observed PostgreSQL row-lock wait');
}
async function addCandidate(f: Fixture, runId: string, options: { type?: string; cancelled?: boolean; payload?: unknown; jobId?: string } = {}) {
  const run = await f.intelligence.createRun({ id: runId, projectId: f.projectId, assetId: f.assetId, capabilities: ['TECHNICAL', 'SHOTS'], idempotencyKey: `candidate-${runId}` });
  const jobId = options.jobId ?? `candidate-job-${runId}`;
  await f.jobs.create({ id: jobId, type: options.type || MEDIA_ANALYSIS, projectId: f.projectId, payload: options.payload ?? {}, idempotencyKey: `candidate-key-${runId}`, maxAttempts: 3 });
  await f.intelligence.attachJob(run.id, jobId);
  if (options.cancelled) await f.jobs.requestCancel(jobId);
  return { runId: run.id, jobId };
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
    const worker = createMediaIntelligenceWorker(f);
    assert.equal(await worker.reconcileQueuedCancellations(), 0);
    assert.equal(await worker.reconcileQueuedCancellations(), 0);
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

test('terminal cancellation fence rejects wrong identities, malformed counts, missing and stale Jobs', async () => {
  const f = await fixture(createFakeIntelligenceProviders());
  let calls = 0;
  try {
    await f.jobs.requestCancel(f.jobId);
    const cases = [
      { id: 'missing-job', owner: expected(f) },
      { id: '', owner: expected(f) },
      { id: f.jobId, owner: { ...expected(f), type: '' } },
      { id: f.jobId, owner: { ...expected(f), projectId: '' } },
      { id: f.jobId, owner: { ...expected(f), type: 'VIDEO_RENDER' } },
      { id: f.jobId, owner: { ...expected(f), projectId: 'wrong-project' } },
      ...[-1, 0.5, NaN, Number.POSITIVE_INFINITY, '0'].map((attemptCount) => ({ id: f.jobId, owner: { ...expected(f), attemptCount: attemptCount as number } })),
    ];
    for (const item of cases) assert.deepEqual(await f.jobs.withCancelledJobFence(item.id, item.owner, async () => { calls += 1; return true; }), { executed: false });
    await f.jobs.requeueTerminal(f.jobId);
    const claimed = await f.jobs.claim(f.jobId, 'replacement', 30_000);
    assert.ok(claimed);
    await f.jobs.requestCancel(f.jobId);
    await f.jobs.cancelAttempt(f.jobId, claimed.attemptId);
    assert.deepEqual(await f.jobs.withCancelledJobFence(f.jobId, expected(f), async () => { calls += 1; return true; }), { executed: false });
    assert.equal(calls, 0);
    assert.deepEqual(await f.jobs.withCancelledJobFence(f.jobId, expected(f, 1), (scope) => cancelOwnedRun(f, scope)), { executed: true, value: true });
    assert.equal((await f.jobs.get(f.jobId))?.attemptCount, 1);
  } finally { await f.close(); }
});

test('owner update distinguishes executed fence from missing, wrong linkage/project and protected run state', async () => {
  const f = await fixture(createFakeIntelligenceProviders());
  try {
    await f.jobs.requestCancel(f.jobId);
    const write = (runId: string, jobId = f.jobId, projectId = f.projectId) => f.jobs.withCancelledJobFence(f.jobId, expected(f), (scope) => f.intelligence.markQueuedCancelledWithExecutor(scope, runId, jobId, projectId));
    assert.deepEqual(await write('missing-run'), { executed: true, value: false });
    assert.deepEqual(await write(f.runId, 'wrong-job'), { executed: true, value: false });
    assert.deepEqual(await write(f.runId, f.jobId, 'wrong-project'), { executed: true, value: false });
    const other = await addCandidate(f, 'linked-other');
    await f.intelligence.attachJob(f.runId, other.jobId);
    assert.deepEqual(await write(f.runId), { executed: true, value: false });
    await f.intelligence.attachJob(f.runId, f.jobId);
    const project = await new ProjectService(f.db).create('other owner');
    await f.db.query('update media_analysis_runs set project_id=$2 where id=$1', [f.runId, project.id]);
    assert.deepEqual(await write(f.runId), { executed: true, value: false });
    await f.db.query('update media_analysis_runs set project_id=$2 where id=$1', [f.runId, f.projectId]);
    for (const status of ['RUNNING', 'SUCCEEDED', 'FAILED', 'STALE']) {
      await f.db.query('update media_analysis_runs set status=$2 where id=$1', [f.runId, status]);
      const before = await f.db.query('select * from media_analysis_runs where id=$1', [f.runId]);
      assert.deepEqual(await write(f.runId), { executed: true, value: false });
      assert.deepEqual((await f.db.query('select * from media_analysis_runs where id=$1', [f.runId])).rows, before.rows);
    }
  } finally { await f.close(); }
});

test('queued cancellation preserves attempts/results and first completion metadata on repeats', async () => {
  const f = await fixture(createFakeIntelligenceProviders());
  try {
    await f.jobs.requestCancel(f.jobId);
    await f.db.query("update media_analysis_runs set attempt_count=2,finished_at='2020-01-01T00:00:00.123Z' where id=$1", [f.runId]);
    await f.db.query('insert into media_analysis_technical (run_id,asset_id,duration_ms,width,height,has_audio,provider,model_version) values ($1,$2,1000,640,360,false,$3,$4)', [f.runId, f.assetId, 'fixture', 'v1']);
    const results = await f.db.query('select * from media_analysis_technical where run_id=$1', [f.runId]);
    const attempts = await f.jobs.attempts(f.jobId);
    assert.deepEqual(await f.jobs.withCancelledJobFence(f.jobId, expected(f), (scope) => cancelOwnedRun(f, scope)), { executed: true, value: true });
    const first = await f.db.query('select * from media_analysis_runs where id=$1', [f.runId]);
    assert.equal(first.rows[0]?.attempt_count, 2);
    assert.equal(first.rows[0]?.finished_at.toISOString(), '2020-01-01T00:00:00.123Z');
    assert.equal(first.rows[0]?.error.code, 'MEDIA_ANALYSIS_JOB_CANCELLED');
    assert.deepEqual(await f.jobs.withCancelledJobFence(f.jobId, expected(f), (scope) => cancelOwnedRun(f, scope)), { executed: true, value: false });
    assert.deepEqual((await f.db.query('select * from media_analysis_runs where id=$1', [f.runId])).rows, first.rows);
    assert.deepEqual((await f.db.query('select * from media_analysis_technical where run_id=$1', [f.runId])).rows, results.rows);
    assert.deepEqual(await f.jobs.attempts(f.jobId), attempts);
  } finally { await f.close(); }
});

test('terminal scope rolls back owner writes and rejects use after rollback or commit', async () => {
  const f = await fixture(createFakeIntelligenceProviders());
  let retained: JobCancellationScope | undefined;
  try {
    await f.jobs.requestCancel(f.jobId);
    const before = await f.db.query('select * from media_analysis_runs where id=$1', [f.runId]);
    await assert.rejects(f.jobs.withCancelledJobFence(f.jobId, expected(f), async (scope) => {
      retained = scope;
      assert.equal(await cancelOwnedRun(f, scope), true);
      throw new Error('owner commit failed');
    }), /owner commit failed/);
    assert.deepEqual((await f.db.query('select * from media_analysis_runs where id=$1', [f.runId])).rows, before.rows);
    assert.ok(retained);
    await assert.rejects(retained.query('select 1'), { code: 'JOB_CANCELLATION_SCOPE_CLOSED' });
    await f.jobs.withCancelledJobFence(f.jobId, expected(f), async (scope) => { retained = scope; return cancelOwnedRun(f, scope); });
    await assert.rejects(retained.query('select 1'), { code: 'JOB_CANCELLATION_SCOPE_CLOSED' });
    assert.equal((await f.intelligence.getRun(f.projectId, f.runId))?.status, 'CANCELLED');
  } finally { await f.close(); }
});

test('terminal callback transaction controls and nested Job APIs cannot commit even if caught', async () => {
  const f = await fixture(createFakeIntelligenceProviders(), 1);
  try {
    await f.jobs.requestCancel(f.jobId);
    for (const sql of ['BEGIN', 'COMMIT', 'ROLLBACK', '/* comment */ BEGIN', 'select 1; COMMIT']) {
      await assert.rejects(f.jobs.withCancelledJobFence(f.jobId, expected(f), async (scope) => {
        await cancelOwnedRun(f, scope);
        await assert.rejects(scope.query(sql), { code: 'JOB_CANCELLATION_QUERY_FORBIDDEN' });
      }), { code: 'JOB_CANCELLATION_QUERY_FORBIDDEN' });
      assert.equal((await f.intelligence.getRun(f.projectId, f.runId))?.status, 'QUEUED');
    }
    for (const kind of ['get', 'nested-fence', 'scoped-create'] as const) {
      await assert.rejects(f.jobs.withCancelledJobFence(f.jobId, expected(f), async (scope) => {
        await cancelOwnedRun(f, scope);
        const call = kind === 'get' ? f.jobs.get(f.jobId) : kind === 'nested-fence' ? f.jobs.withCancelledJobFence(f.jobId, expected(f), async () => true) : f.jobs.createWithExecutor(scope, { id: 'nested-job', type: MEDIA_ANALYSIS, projectId: f.projectId, payload: {}, idempotencyKey: 'nested-job', maxAttempts: 3 });
        await assert.rejects(call, { code: 'JOB_CANCELLATION_NESTED_JOB_CALL' });
      }), { code: 'JOB_CANCELLATION_NESTED_JOB_CALL' });
      assert.equal((await f.intelligence.getRun(f.projectId, f.runId))?.status, 'QUEUED');
    }
    await assert.rejects(f.jobs.withCancelledJobFence(f.jobId, expected(f), async (scope) => {
      await cancelOwnedRun(f, scope);
      await assert.rejects(scope.query('select * from nonexistent_cancellation_fixture_table'), { code: '42P01' });
    }), { code: '42P01' });
    assert.equal((await f.intelligence.getRun(f.projectId, f.runId))?.status, 'QUEUED');
    await assert.rejects(f.jobs.withCancelledJobFence(f.jobId, expected(f), async (scope) => {
      await cancelOwnedRun(f, scope);
      void scope.query('select pg_sleep(0.05)');
    }), { code: 'JOB_CANCELLATION_QUERY_NOT_AWAITED' });
    assert.equal((await f.intelligence.getRun(f.projectId, f.runId))?.status, 'QUEUED');
  } finally { await f.close(); }
});

test('requeue wins first: real queued row locks make terminal fence reject without owner callback', async () => {
  const f = await fixture(createFakeIntelligenceProviders());
  const blocker = await f.db.connect();
  let transactionOpen = false;
  let requeue: ReturnType<JobService['requeueTerminal']> | undefined;
  let fence: ReturnType<JobService['withCancelledJobFence']> | undefined;
  let calls = 0;
  try {
    await f.jobs.requestCancel(f.jobId);
    await blocker.query('begin'); transactionOpen = true;
    const backend = await blocker.query<{ pid: number }>('select pg_backend_pid() as pid');
    await blocker.query('select id from jobs where id=$1 for update', [f.jobId]);
    requeue = f.jobs.requeueTerminal(f.jobId);
    const requeuePid = await waitBlocked(f.db, backend.rows[0]!.pid, "update jobs set state = 'QUEUED'");
    fence = f.jobs.withCancelledJobFence(f.jobId, expected(f), async (scope) => { calls += 1; return cancelOwnedRun(f, scope); });
    await waitBlocked(f.db, requeuePid, 'select id, type, project_id, state, attempt_count from jobs');
    await blocker.query('commit'); transactionOpen = false;
    assert.equal((await requeue).state, 'QUEUED');
    assert.deepEqual(await fence, { executed: false });
    assert.equal(calls, 0);
    assert.equal((await f.intelligence.getRun(f.projectId, f.runId))?.status, 'QUEUED');
    assert.ok(await f.jobs.claim(f.jobId, 'new-attempt', 30_000));
  } finally {
    if (transactionOpen) await blocker.query('rollback');
    await Promise.allSettled([requeue, fence]);
    blocker.release(); await f.close();
  }
});

test('fence wins first: observed requeue row lock waits until owner commit before replacement claim', async () => {
  const f = await fixture(createFakeIntelligenceProviders());
  let releaseOwner!: () => void;
  let signalEntered!: (pid: number) => void;
  const ownerGate = new Promise<void>((resolve) => { releaseOwner = resolve; });
  const entered = new Promise<number>((resolve) => { signalEntered = resolve; });
  let fence: ReturnType<JobService['withCancelledJobFence']> | undefined;
  let requeue: ReturnType<JobService['requeueTerminal']> | undefined;
  try {
    await f.jobs.requestCancel(f.jobId);
    fence = f.jobs.withCancelledJobFence(f.jobId, expected(f), async (scope) => {
      const backend = await scope.query<{ pid: number }>('select pg_backend_pid() as pid');
      signalEntered(backend.rows[0]!.pid);
      await ownerGate; // Test-only scheduling barrier; no provider/external I/O.
      return cancelOwnedRun(f, scope);
    });
    const pid = await entered;
    requeue = f.jobs.requeueTerminal(f.jobId);
    await waitBlocked(f.db, pid, "update jobs set state = 'QUEUED'");
    releaseOwner();
    assert.deepEqual(await fence, { executed: true, value: true });
    assert.equal((await requeue).state, 'QUEUED');
    assert.equal((await f.intelligence.getRun(f.projectId, f.runId))?.status, 'CANCELLED');
    const newAttempt = await f.jobs.claim(f.jobId, 'after-cancel-commit', 30_000);
    assert.ok(newAttempt);
    assert.equal(newAttempt.job.attemptCount, 1);
  } finally {
    releaseOwner(); await Promise.allSettled([fence, requeue]); await f.close();
  }
});

test('small pool terminal owner commits progress without opening nested pool connections', async () => {
  const f = await fixture(createFakeIntelligenceProviders(), 1);
  try {
    const candidates = await Promise.all(['pool-a', 'pool-b', 'pool-c'].map((id) => addCandidate(f, id, { cancelled: true })));
    const results = await Promise.all(candidates.map((candidate) => f.jobs.withCancelledJobFence(candidate.jobId, expected(f), (scope) => f.intelligence.markQueuedCancelledWithExecutor(scope, candidate.runId, candidate.jobId, f.projectId))));
    assert.ok(results.every((result) => result.executed && result.value));
    for (const candidate of candidates) assert.equal((await f.intelligence.getRun(f.projectId, candidate.runId))?.status, 'CANCELLED');
  } finally { await f.close(); }
});

test('fair bounded discovery passes malformed/pending candidates, honors cycle bound and wraps', async () => {
  const providers = createFakeIntelligenceProviders();
  let providerCalls = 0;
  const probe = providers.technical.probe.bind(providers.technical);
  providers.technical.probe = async (input) => { providerCalls += 1; return probe(input); };
  const f = await fixture(providers);
  const worker = createMediaIntelligenceWorker(f, { cancellationBatchSize: 2 });
  try {
    // Unlinked fixture run is deliberately excluded from the owned linked scan.
    await f.db.query('update media_analysis_runs set job_id=null where id=$1', [f.runId]);
    await addCandidate(f, '00-malformed', { cancelled: true, jobId: '' });
    const pending = await addCandidate(f, '01-pending');
    await addCandidate(f, '02-wrong-type', { type: 'VIDEO_RENDER', cancelled: true });
    const target = await addCandidate(f, '99-target', { cancelled: true, payload: { runId: 'wrong-payload-run', projectId: 'wrong-payload-project' } });
    const firstBatch = await f.intelligence.listQueuedCancellationCandidates(null, null, 2);
    assert.equal(firstBatch.length, 2);
    assert.equal(firstBatch[0]?.throughId, '99-target');
    const firstPass = worker.reconcileQueuedCancellations();
    assert.equal(worker.reconcileQueuedCancellations(), firstPass, 'concurrent scans share the active cursor pass');
    assert.equal(await firstPass, 0);
    const inserted = await addCandidate(f, 'zz-inserted', { cancelled: true });
    assert.equal(await worker.reconcileQueuedCancellations(), 1);
    assert.equal((await f.intelligence.getRun(f.projectId, target.runId))?.status, 'CANCELLED');
    assert.equal((await f.intelligence.getRun(f.projectId, inserted.runId))?.status, 'QUEUED', 'new ids above the cycle bound wait for wraparound');
    await f.jobs.requestCancel(pending.jobId);
    assert.equal(await worker.reconcileQueuedCancellations(), 1, 'wraparound revisits an earlier newly cancelled record');
    assert.equal((await f.intelligence.getRun(f.projectId, pending.runId))?.status, 'CANCELLED');
    assert.equal(await worker.reconcileQueuedCancellations(), 1);
    assert.equal((await f.intelligence.getRun(f.projectId, inserted.runId))?.status, 'CANCELLED');
    assert.equal((await f.intelligence.getRun(f.projectId, f.runId))?.status, 'QUEUED');
    assert.equal(providerCalls, 0);
  } finally { await f.close(); }
});
