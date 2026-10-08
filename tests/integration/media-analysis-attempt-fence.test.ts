import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { JobService, JobRunner, type JobAttemptScope, type JobHeartbeat } from '../../packages/modules/job/src/index.js';
import { MEDIA_ANALYSIS, MediaIntelligenceService, createFakeIntelligenceProviders } from '../../packages/modules/intelligence/src/index.js';
import { createMediaAnalysisJobHandler } from '../../workers/media-intelligence-worker/src/handler.js';

// Intentionally red safety requirements, not registered in a green CI gate.
// Every provider is FAKE; explicit promise barriers control the old attempt.
async function fixture(outcome: 'success' | 'failure' | 'abort' = 'success') {
  const databaseUrl = process.env.CONTENTOS_TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'explicit isolated contentos_test URL required');
  assert.equal(new URL(databaseUrl).pathname, '/contentos_test');
  const admin = await createDatabase(databaseUrl);
  assert.equal((await admin.query('select current_database() as name')).rows[0]?.name, 'contentos_test');
  const schema = `contentos_attempt_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`); await admin.end();
  const url = new URL(databaseUrl); url.searchParams.set('options', `-c search_path=${schema}`);
  const db = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 1_500 });
  await migrateUp(db);
  const project = await new ProjectService(db).create(`Attempt fence ${randomUUID()}`);
  const assetId = `asset-attempt-${randomUUID()}`;
  await db.query('insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [assetId, project.id, 'VIDEO', `checksum-${assetId}`, 1, `fixtures/${assetId}.mp4`, 'READY', { durationMs: 1_000, width: 640, height: 360, hasAudio: false }]);
  const providers = createFakeIntelligenceProviders();
  const fakeProbe = providers.technical.probe.bind(providers.technical);
  let signalEntered!: () => void; let releaseOld!: () => void;
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
  const released = new Promise<void>((resolve) => { releaseOld = resolve; });
  let fakeCalls = 0;
  providers.technical.probe = async (input) => {
    fakeCalls += 1; const invocation = fakeCalls;
    if (invocation === 1) {
      signalEntered(); await released; // Deliberately ignores abort until explicit release.
      if (outcome === 'failure') throw Object.assign(new Error('OLD_PROVIDER_FAILURE'), { code: 'OLD_PROVIDER_FAILURE' });
      if (outcome === 'abort') input.signal?.throwIfAborted();
    }
    return { ...await fakeProbe(input), width: invocation === 1 ? 640 : 1920, modelVersion: invocation === 1 ? 'old-attempt' : 'replacement-attempt' };
  };
  const intelligence = new MediaIntelligenceService(db, providers);
  const run = await intelligence.createRun({ projectId: project.id, assetId, capabilities: ['TECHNICAL', 'SHOTS'] });
  const jobs = new JobService(db); const jobId = `job-attempt-${randomUUID()}`;
  await jobs.create({ id: jobId, projectId: project.id, type: MEDIA_ANALYSIS, payload: { schemaVersion: 'MEDIA_ANALYSIS_JOB_V1', projectId: project.id, assetId, runId: run.id, correlationId: `corr-${run.id}` }, idempotencyKey: jobId, maxAttempts: 3 });
  await intelligence.attachJob(run.id, jobId);
  const handler = createMediaAnalysisJobHandler({ jobs, intelligence });
  const snapshot = async () => ({
    run: (await db.query('select status,error,finished_at,attempt_count from media_analysis_runs where id=$1', [run.id])).rows,
    technical: (await db.query('select * from media_analysis_technical where run_id=$1', [run.id])).rows,
    shots: (await db.query('select * from media_analysis_shots where run_id=$1 order by id', [run.id])).rows,
  });
  const waitEntered = async () => {
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([entered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Fake provider barrier not reached')), 2_000); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const close = async () => { try { await db.query(`drop schema "${schema}" cascade`); } finally { await db.end(); } };
  return { db, projectId: project.id, jobs, intelligence, jobId, runId: run.id, handler, snapshot, waitEntered, releaseOld, close, fakeCalls: () => fakeCalls };
}

for (const outcome of ['success', 'failure', 'abort'] as const) {
  test(`RED: recovered old attempt late ${outcome} must preserve replacement analysis results`, async () => {
    const f = await fixture(outcome); const controller = new AbortController();
    let oldWork: Promise<{ ok: boolean; value?: unknown; error?: unknown }> | undefined;
    try {
      const old = await f.jobs.claim(f.jobId, 'old-worker', 30_000); assert.ok(old);
      oldWork = f.handler(old.job, old.attemptId, controller.signal).then((value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }));
      await f.waitEntered();
      // Inject reconciliation clock beyond the real persisted lease, no timeout race.
      const expiredAt = new Date(old.job.leaseExpiresAt!.getTime() + 1_000);
      assert.equal(await f.jobs.reconcileExpiredLeases(expiredAt), 1);
      assert.equal((await f.jobs.get(f.jobId))?.state, 'RETRY_WAIT');
      const replacement = await f.jobs.claim(f.jobId, 'replacement-worker', 30_000); assert.ok(replacement);
      assert.notEqual(replacement.attemptId, old.attemptId);
      let staleCallbacks = 0;
      assert.deepEqual(await f.jobs.withCurrentAttemptFence(f.jobId, old.attemptId, async () => { staleCallbacks += 1; return true; }), { executed: false });
      assert.equal(staleCallbacks, 0, 'existing Job fence already rejects the stale attempt');
      const replacementResult = await f.handler(replacement.job, replacement.attemptId, new AbortController().signal);
      await f.jobs.succeed(f.jobId, replacement.attemptId, replacementResult);
      const before = await f.snapshot();
      assert.equal(before.run[0]?.status, 'SUCCEEDED');
      assert.equal(before.technical[0]?.model_version, 'replacement-attempt');
      if (outcome === 'abort') controller.abort(new DOMException('Old attempt lost authority', 'AbortError'));
      f.releaseOld(); const late = await oldWork;
      assert.equal(late.ok, outcome === 'success');
      if (late.ok) await f.jobs.succeed(f.jobId, old.attemptId, late.value);
      else await f.jobs.fail(f.jobId, old.attemptId, { code: outcome === 'abort' ? 'ABORT_ERR' : 'OLD_PROVIDER_FAILURE' }, true);
      assert.equal((await f.jobs.get(f.jobId))?.state, 'SUCCEEDED', 'Job terminal write is correctly fenced');
      assert.deepEqual((await f.jobs.attempts(f.jobId)).map((a) => a.status), ['FAILED', 'SUCCEEDED']);
      assert.equal(f.fakeCalls(), 2);
      const after = await f.snapshot();
      console.log(JSON.stringify({ evidence: 'late_old_attempt', outcome, jobState: 'SUCCEEDED', runStatus: after.run[0]?.status, technicalModel: after.technical[0]?.model_version, technicalWidth: after.technical[0]?.width, realProviderCalls: 0 }));
      assert.deepEqual(after, before, 'stale success/failure/cancellation must not overwrite current run or results');
    } finally { f.releaseOld(); if (oldWork) await oldWork; await f.close(); }
  });
}

test('RED: provider returning after durable cancellation must not resurrect analysis or publish results', async () => {
  const f = await fixture(); const controller = new AbortController();
  let work: Promise<unknown> | undefined;
  try {
    const attempt = await f.jobs.claim(f.jobId, 'cancelled-worker', 30_000); assert.ok(attempt);
    work = f.handler(attempt.job, attempt.attemptId, controller.signal).catch((error: unknown) => error);
    await f.waitEntered(); await f.jobs.requestCancel(f.jobId);
    controller.abort(new DOMException('User cancelled analysis', 'AbortError'));
    await f.intelligence.markCancelled(f.runId);
    await f.jobs.cancelAttempt(f.jobId, attempt.attemptId);
    const before = await f.snapshot(); assert.equal(before.run[0]?.status, 'CANCELLED'); assert.equal(before.technical.length, 0);
    f.releaseOld(); await work;
    assert.equal((await f.jobs.get(f.jobId))?.state, 'CANCELLED');
    const after = await f.snapshot();
    console.log(JSON.stringify({ evidence: 'provider_after_cancel', jobState: 'CANCELLED', runStatus: after.run[0]?.status, technicalRows: after.technical.length, realProviderCalls: 0 }));
    assert.deepEqual(after, before, 'late non-cooperative provider must leave durable cancellation and results unchanged');
  } finally { f.releaseOld(); if (work) await work; await f.close(); }
});

test('existing Job attempt fence skips stale/cancelled owners and commits current owner atomically', async () => {
  const f = await fixture();
  try {
    const old = await f.jobs.claim(f.jobId, 'old-fence-worker', 30_000); assert.ok(old);
    assert.equal(await f.jobs.reconcileExpiredLeases(new Date(old.job.leaseExpiresAt!.getTime() + 1_000)), 1);
    const current = await f.jobs.claim(f.jobId, 'current-fence-worker', 30_000); assert.ok(current);
    let callbacks = 0;
    assert.deepEqual(await f.jobs.withCurrentAttemptFence(f.jobId, old.attemptId, async () => { callbacks += 1; return true; }), { executed: false });
    assert.deepEqual(await f.jobs.withCurrentAttemptFence(f.jobId, current.attemptId, async (scope) => {
      callbacks += 1; assert.equal(scope.attemptNumber, 2);
      await scope.query("update media_analysis_runs set status='RUNNING' where id=$1 and job_id=$2 and project_id=$3", [f.runId, f.jobId, f.projectId]); return true;
    }), { executed: true, value: true });
    await f.jobs.requestCancel(f.jobId);
    assert.deepEqual(await f.jobs.withCurrentAttemptFence(f.jobId, current.attemptId, async () => { callbacks += 1; return true; }), { executed: false });
    assert.equal(callbacks, 1); assert.equal(f.fakeCalls(), 0);
  } finally { await f.close(); }
});

// Terminal-contract probes model a rejected generation with fixture-owned SQL.
// They invoke real public Job APIs/Runner; they are not new production owner ports.
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function setGeneration(f: Fixture, scope: JobAttemptScope) {
  await scope.query("update media_analysis_runs set status='RUNNING',attempt_count=2 where id=$1 and job_id=$2 and project_id=$3", [f.runId, f.jobId, f.projectId]);
}
async function rejectedGenerationWrite(f: Fixture, scope: JobAttemptScope) {
  const result = await scope.query("update media_analysis_runs set status='SUCCEEDED' where id=$1 and job_id=$2 and project_id=$3 and status='RUNNING' and attempt_count=1", [f.runId, f.jobId, f.projectId]);
  assert.equal(result.rowCount, 0, 'old generation owner write is rejected');
}
for (const terminal of ['success', 'failure', 'cancel'] as const) {
  test(`RED: ${terminal} callback rejecting same-attempt generation must not terminalize its Job`, async () => {
    const f = await fixture();
    try {
      const current = await f.jobs.claim(f.jobId, 'generation-worker', 30_000); assert.ok(current);
      await f.jobs.withCurrentAttemptFence(f.jobId, current.attemptId, (scope) => setGeneration(f, scope));
      if (terminal === 'cancel') await f.jobs.requestCancel(f.jobId);
      const before = await f.snapshot();
      if (terminal === 'success') await f.jobs.succeedWithCurrentAttempt(f.jobId, current.attemptId, async (scope) => {
        await rejectedGenerationWrite(f, scope); return { kind: 'STALE_GENERATION' };
      });
      if (terminal === 'failure') await f.jobs.fail(f.jobId, current.attemptId, { code: 'OLD_GENERATION' }, false, (scope) => rejectedGenerationWrite(f, scope));
      if (terminal === 'cancel') await f.jobs.cancelAttempt(f.jobId, current.attemptId, (scope) => rejectedGenerationWrite(f, scope));
      assert.deepEqual(await f.snapshot(), before, 'owner remains on generation 2'); assert.equal(f.fakeCalls(), 0);
      const job = await f.jobs.get(f.jobId);
      console.log(JSON.stringify({ evidence: 'no_owner_write_terminalizes_job', terminal, jobState: job?.state, generation: 2, providerCalls: 0 }));
      assert.equal(job?.state, terminal === 'cancel' ? 'CANCEL_REQUESTED' : 'RUNNING', 'owner rejection must abort the entire terminal transaction');
    } finally { await f.close(); }
  });
}

test('RED: owner stale-generation rollback must not be converted into generic Runner failure', async () => {
  const f = await fixture(); let rolledBack = false;
  try {
    const result = await new JobRunner(f.jobs, 'stale-generation-runner').run(f.jobId, async (_job, attemptId) => {
      await f.jobs.withCurrentAttemptFence(f.jobId, attemptId, (scope) => setGeneration(f, scope));
      try {
        await f.jobs.succeedWithCurrentAttempt(f.jobId, attemptId, async (scope) => {
          await rejectedGenerationWrite(f, scope);
          throw Object.assign(new Error('Generation no longer owns the run'), { code: 'MEDIA_ANALYSIS_STALE_GENERATION', retryable: false });
        });
      } catch (error) {
        rolledBack = (await f.jobs.get(f.jobId))?.state === 'RUNNING';
        throw error;
      }
      return {};
    });
    assert.equal(rolledBack, true, 'terminal callback exception really rolled back before Runner fallback');
    assert.equal((await f.snapshot()).run[0]?.status, 'RUNNING'); assert.equal(f.fakeCalls(), 0);
    console.log(JSON.stringify({ evidence: 'runner_converts_stale_rollback', jobState: result.state, rolledBack, providerCalls: 0 }));
    assert.equal(result.state, 'RUNNING', 'control-plane stale generation must escape generic Runner.fail');
  } finally { await f.close(); }
});

test('RED: cancellation between handler final fence check and Runner pulse must finalize the owner atomically', async () => {
  const f = await fixture();
  try {
    const result = await new JobRunner(f.jobs, 'cancel-window-runner').run(f.jobId, async (_job, attemptId) => {
      const checked = await f.jobs.withCurrentAttemptFence(f.jobId, attemptId, (scope) => setGeneration(f, scope));
      assert.equal(checked.executed, true);
      // Deterministic cancellation in the exact final-check -> handler-return -> pulse gap.
      await f.jobs.requestCancel(f.jobId); return { status: 'SUCCEEDED' };
    });
    assert.equal(result.state, 'CANCELLED'); assert.equal(f.fakeCalls(), 0);
    const run = (await f.snapshot()).run[0];
    console.log(JSON.stringify({ evidence: 'runner_cancel_without_owner', jobState: result.state, runStatus: run?.status, providerCalls: 0 }));
    assert.equal(run?.status, 'CANCELLED', 'Runner.cancelAttempt without owner callback leaves RUNNING analysis');
  } finally { await f.close(); }
});

test('RED: heartbeat transport ERROR must not trigger ownerless generic Runner.fail', async () => {
  const f = await fixture();
  class HeartbeatUnavailableJobs extends JobService {
    override async heartbeat(_id: string, _attemptId: string, _leaseMs: number): Promise<JobHeartbeat> {
      throw Object.assign(new Error('Synthetic heartbeat transport failure'), { code: 'TEST_HEARTBEAT_TRANSPORT' });
    }
  }
  try {
    const jobs = new HeartbeatUnavailableJobs(f.db);
    const result = await new JobRunner(jobs, 'heartbeat-error-runner').run(f.jobId, async (_job, attemptId) => {
      await f.jobs.withCurrentAttemptFence(f.jobId, attemptId, (scope) => setGeneration(f, scope)); return {};
    });
    const run = (await f.snapshot()).run[0]; assert.equal(run?.status, 'RUNNING'); assert.equal(f.fakeCalls(), 0);
    console.log(JSON.stringify({ evidence: 'runner_heartbeat_error_without_owner', jobState: result.state, runStatus: run?.status, providerCalls: 0 }));
    assert.equal(result.state, 'RUNNING', 'uncertain heartbeat must park or use coordinated owner protocol, not ownerless failure');
  } finally { await f.close(); }
});

test('RED: handler abort must not fall through to ownerless Runner cancellation', async () => {
  const f = await fixture();
  try {
    const result = await new JobRunner(f.jobs, 'abort-runner').run(f.jobId, async (_job, attemptId) => {
      await f.jobs.withCurrentAttemptFence(f.jobId, attemptId, (scope) => setGeneration(f, scope));
      await f.jobs.requestCancel(f.jobId); throw new DOMException('Cancelled handler', 'AbortError');
    });
    assert.equal(result.state, 'CANCELLED'); assert.equal(f.fakeCalls(), 0);
    assert.equal((await f.snapshot()).run[0]?.status, 'CANCELLED', 'catch-path cancellation must include owner callback');
  } finally { await f.close(); }
});

test('RED: successful handler return alone must not close Job without owner finalization', async () => {
  const f = await fixture();
  try {
    const result = await new JobRunner(f.jobs, 'success-fallback-runner').run(f.jobId, async (_job, attemptId) => {
      await f.jobs.withCurrentAttemptFence(f.jobId, attemptId, (scope) => setGeneration(f, scope)); return { kind: 'STALE_GENERATION' };
    });
    assert.equal((await f.snapshot()).run[0]?.status, 'RUNNING'); assert.equal(f.fakeCalls(), 0);
    assert.equal(result.state, 'RUNNING', 'structured stale result must not become generic Runner.succeed');
  } finally { await f.close(); }
});

test('generic Runner correctly leaves replacement Job ownership intact after real recovery', async () => {
  const f = await fixture();
  try {
    const result = await new JobRunner(f.jobs, 'old-owner-runner').run(f.jobId, async (job, attemptId) => {
      await f.jobs.withCurrentAttemptFence(f.jobId, attemptId, (scope) => setGeneration(f, scope));
      assert.equal(await f.jobs.reconcileExpiredLeases(new Date(job.leaseExpiresAt!.getTime() + 1_000)), 1);
      assert.ok(await f.jobs.claim(f.jobId, 'replacement-owner', 30_000));
      throw Object.assign(new Error('Old Job ownership revoked'), { code: 'STALE_JOB_OWNER', retryable: false });
    });
    assert.equal(result.state, 'RUNNING'); assert.equal(result.attemptCount, 2);
    assert.deepEqual((await f.jobs.attempts(f.jobId)).map((a) => a.status), ['FAILED', 'RUNNING']);
    assert.equal((await f.snapshot()).run[0]?.status, 'RUNNING'); assert.equal(f.fakeCalls(), 0);
  } finally { await f.close(); }
});
