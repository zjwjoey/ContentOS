import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { JobService, type JobLeaseRecoveryOwners } from '../../packages/modules/job/src/index.js';
import { MediaIntelligenceService, MediaAnalysisAttemptOwner, createFakeIntelligenceProviders, type AnalysisStartDecision } from '../../packages/modules/intelligence/src/index.js';

async function fixture(max = 4) {
  const raw = process.env.CONTENTOS_TEST_DATABASE_URL;
  assert.ok(raw); assert.equal(new URL(raw).pathname, '/contentos_test');
  const admin = await createDatabase(raw);
  assert.equal((await admin.query('select current_database() as name')).rows[0]?.name, 'contentos_test');
  const schema = `contentos_owner_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`); await admin.end();
  const url = new URL(raw); url.searchParams.set('options', `-c search_path=${schema}`);
  const db = new pg.Pool({ connectionString: url.toString(), max, connectionTimeoutMillis: 1_500 });
  await migrateUp(db);
  const project = await new ProjectService(db).create('Owner fixture'); const assetId = `asset-${randomUUID()}`;
  await db.query('insert into assets(id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values($1,$2,\'VIDEO\',\'checksum\',1,\'fake.mp4\',\'READY\',$3)', [assetId, project.id, { durationMs: 1000, width: 640, height: 360 }]);
  const providers = createFakeIntelligenceProviders();
  // No provider method may be invoked by this contract segment.
  for (const name of ['technical', 'shots', 'asr', 'vision', 'embedding'] as const) {
    for (const key of ['probe', 'detect', 'transcribe', 'analyze', 'embed']) {
      if (key in providers[name]) (providers[name] as unknown as Record<string, unknown>)[key] = async () => { throw new Error('PROVIDER_CALL_FORBIDDEN'); };
    }
  }
  const intelligence = new MediaIntelligenceService(db, providers);
  const run = await intelligence.createRun({ projectId: project.id, assetId, capabilities: ['TECHNICAL'] });
  const jobs = new JobService(db); const jobId = `job-${randomUUID()}`;
  await jobs.create({ id: jobId, projectId: project.id, type: 'MEDIA_ANALYSIS', payload: {}, idempotencyKey: jobId, maxAttempts: 3 });
  await intelligence.attachJob(run.id, jobId);
  const owner = new MediaAnalysisAttemptOwner();
  const link = { runId: run.id, jobId, projectId: project.id, assetId, sourceChecksum: 'checksum' };
  const claim = async () => { const value = await jobs.claim(jobId, 'owner-fixture', 30_000); assert.ok(value); return value; };
  const start = async (attemptId: string) => { const result = await jobs.withOwnerRecoveryAttemptFence(jobId, attemptId, 'MEDIA_ANALYSIS', (scope) => owner.start(scope, link)); assert.ok(result.executed); return result.value; };
  const owners: JobLeaseRecoveryOwners = new Map([['MEDIA_ANALYSIS', (job, scope, outcome) => owner.recover(job, scope, outcome)]]);
  const rows = async () => (await db.query('select * from media_analysis_runs where id=$1', [run.id])).rows;
  const close = async () => { try { await db.query(`drop schema "${schema}" cascade`); } finally { await db.end(); } };
  return { db, jobs, intelligence, owner, link, jobId, claim, start, owners, rows, close };
}

test('binding start is atomic, duplicate start is rejected, immutable public config remains intact', async () => {
  const f = await fixture(1);
  try {
    const baseline = (await f.rows())[0]; const current = await f.claim(); const started = await f.start(current.attemptId);
    assert.equal(started.kind, 'STARTED'); assert.equal(started.identity.generation, 1);
    assert.equal((await f.rows())[0]?.active_job_attempt_id, current.attemptId);
    assert.equal((await f.db.query('select requires_owner_recovery from jobs where id=$1', [f.jobId])).rows[0]?.requires_owner_recovery, true);
    const before = await f.rows();
    await assert.rejects(f.start(current.attemptId), { code: 'MEDIA_ANALYSIS_DUPLICATE_START' });
    assert.deepEqual(await f.rows(), before); assert.equal((await f.jobs.get(f.jobId))?.state, 'RUNNING');
    assert.deepEqual(before[0]?.config_snapshot, baseline?.config_snapshot); assert.equal(before[0]?.analysis_fingerprint, baseline?.analysis_fingerprint);
  } finally { await f.close(); }
});

test('global recovery from a different JobService skips opted-in Media but preserves other types', async () => {
  const f = await fixture();
  try {
    const current = await f.claim(); await f.start(current.attemptId);
    const other = `other-${randomUUID()}`;
    await f.jobs.create({ id: other, projectId: f.link.projectId, type: 'UNRELATED_FIXTURE', payload: {}, idempotencyKey: other, maxAttempts: 3 });
    assert.ok(await f.jobs.claim(other, 'other-worker', 30_000));
    const clock = new Date(Date.now() + 60_000); const outsider = new JobService(f.db);
    let legacyCalls = 0;
    assert.equal(await outsider.reconcileExpiredLeases(clock, async () => { legacyCalls += 1; return true; }), 1);
    assert.equal((await f.jobs.get(other))?.state, 'RETRY_WAIT'); assert.equal((await f.jobs.get(f.jobId))?.state, 'RUNNING');
    assert.equal(legacyCalls, 0);
    await f.jobs.requestCancel(f.jobId);
    assert.equal(await outsider.reconcileExpiredLeases(clock, async () => { legacyCalls += 1; return true; }), 0);
    assert.equal(legacyCalls, 0, 'legacy cancellation callback cannot bypass persisted owner policy');
    assert.equal(await outsider.reconcileExpiredLeases(clock, undefined, f.owners), 1);
    assert.equal((await f.jobs.get(f.jobId))?.state, 'CANCELLED'); assert.equal((await f.rows())[0]?.status, 'CANCELLED');
  } finally { await f.close(); }
});

test('owner recovery rolls back partial writes/errors and normal recovery permits only a new attempt', async () => {
  const f = await fixture(1);
  try {
    const old = await f.claim(); const first = await f.start(old.attemptId); const before = await f.rows();
    const broken: JobLeaseRecoveryOwners = new Map([['MEDIA_ANALYSIS', async (_job, scope) => {
      await scope.query("update media_analysis_runs set status='QUEUED' where id=$1", [f.link.runId]); throw new Error('OWNER_WRITE_THEN_THROW');
    }]]);
    const clock = new Date(old.job.leaseExpiresAt!.getTime() + 1000);
    assert.equal(await f.jobs.reconcileExpiredLeases(clock, undefined, broken), 0);
    assert.deepEqual(await f.rows(), before); assert.equal((await f.jobs.get(f.jobId))?.state, 'RUNNING');
    assert.equal(await f.jobs.reconcileExpiredLeases(clock, undefined, f.owners), 1);
    assert.equal((await f.rows())[0]?.status, 'QUEUED');
    assert.deepEqual(await f.jobs.withCurrentAttemptFence(f.jobId, old.attemptId, (scope) => f.owner.finish(scope, first.identity, 'FAILED')), { executed: false });
    const next = await f.claim(); const second = await f.start(next.attemptId);
    assert.equal(second.identity.generation, 2); assert.equal(second.identity.attemptNumber, 2);
    assert.equal((await f.rows())[0]?.active_job_attempt_id, next.attemptId);
  } finally { await f.close(); }
});

for (const outcome of ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
  test(`stale generation veto rolls back Job ${outcome}; current generation commits atomically`, async () => {
    const f = await fixture();
    try {
      const current = await f.claim(); const started = await f.start(current.attemptId);
      if (outcome === 'CANCELLED') await f.jobs.requestCancel(f.jobId);
      const finish = (identity: AnalysisStartDecision['identity']) => outcome === 'SUCCEEDED'
        ? f.jobs.succeedWithCurrentAttempt(f.jobId, current.attemptId, (scope) => f.owner.finish(scope, identity, outcome))
        : outcome === 'FAILED'
          ? f.jobs.fail(f.jobId, current.attemptId, { code: 'TEST_FAILURE' }, false, async (scope) => { await f.owner.finish(scope, identity, outcome); })
          : f.jobs.cancelAttempt(f.jobId, current.attemptId, async (scope) => { await f.owner.finish(scope, identity, outcome); });
      const before = await f.rows();
      await assert.rejects(finish({ ...started.identity, generation: 999 }), { code: 'MEDIA_ANALYSIS_STALE_GENERATION' });
      assert.deepEqual(await f.rows(), before); assert.equal((await f.jobs.get(f.jobId))?.state, outcome === 'CANCELLED' ? 'CANCEL_REQUESTED' : 'RUNNING');
      await finish(started.identity);
      assert.equal((await f.rows())[0]?.status, outcome); assert.equal((await f.jobs.get(f.jobId))?.state, outcome === 'SUCCEEDED' ? 'SUCCEEDED' : outcome === 'FAILED' ? 'FAILED' : 'CANCELLED');
      if (outcome !== 'SUCCEEDED') {
        await f.jobs.requeueTerminal(f.jobId); const next = await f.claim();
        assert.equal((await f.start(next.attemptId)).identity.generation, 2);
      }
    } finally { await f.close(); }
  });
}

test('reuse preserves results/generation; legacy RUNNING and linkage mismatch refuse first binding', async () => {
  const f = await fixture();
  try {
    const current = await f.claim();
    await f.db.query("update media_analysis_runs set status='RUNNING' where id=$1", [f.link.runId]);
    await assert.rejects(f.start(current.attemptId), { code: 'MEDIA_ANALYSIS_LEGACY_DRAIN_REQUIRED' });
    assert.equal((await f.db.query('select requires_owner_recovery from jobs where id=$1', [f.jobId])).rows[0]?.requires_owner_recovery, false);
    await assert.rejects(f.jobs.withOwnerRecoveryAttemptFence(f.jobId, current.attemptId, 'MEDIA_ANALYSIS', (scope) => f.owner.start(scope, { ...f.link, assetId: 'wrong-asset' })), { code: 'MEDIA_ANALYSIS_STALE_OWNER' });
    await f.db.query("update media_analysis_runs set status='SUCCEEDED',attempt_count=1,finished_at=now() where id=$1", [f.link.runId]);
    await f.db.query('insert into media_analysis_technical(run_id,asset_id,duration_ms,width,height,has_audio,provider,model_version) values($1,$2,1000,640,360,false,$3,$4)', [f.link.runId, f.link.assetId, 'fixture', 'reuse']);
    const resultsBefore = (await f.db.query('select * from media_analysis_technical where run_id=$1', [f.link.runId])).rows;
    const before = (await f.rows())[0]; const reuse = await f.start(current.attemptId); assert.equal(reuse.kind, 'REUSE');
    const result = await f.jobs.succeedWithCurrentAttempt(f.jobId, current.attemptId, (scope) => f.owner.finish(scope, reuse.identity, 'REUSE'));
    assert.equal(result.executed, true); const after = (await f.rows())[0];
    assert.equal(after?.attempt_count, 1); assert.deepEqual(after?.finished_at, before?.finished_at); assert.equal(after?.status, 'SUCCEEDED');
    assert.deepEqual((await f.db.query('select * from media_analysis_technical where run_id=$1', [f.link.runId])).rows, resultsBefore);
  } finally { await f.close(); }
});


test('owner write then throw rolls back owner and Job; all persisted linkage dimensions reject mismatch', async () => {
  const f = await fixture();
  try {
    const current = await f.claim();
    await assert.rejects(f.jobs.withOwnerRecoveryAttemptFence(f.jobId, current.attemptId, 'OTHER_TYPE', (scope) => f.owner.start(scope, f.link)), { code: 'JOB_OWNER_RECOVERY_TYPE_MISMATCH' });
    for (const bad of [{ runId: 'missing' }, { jobId: 'wrong' }, { projectId: 'wrong' }, { assetId: 'wrong' }]) {
      await assert.rejects(f.jobs.withOwnerRecoveryAttemptFence(f.jobId, current.attemptId, 'MEDIA_ANALYSIS', (scope) => f.owner.start(scope, { ...f.link, ...bad })), { code: 'MEDIA_ANALYSIS_STALE_OWNER' });
    }
    const started = await f.start(current.attemptId); const before = await f.rows();
    await assert.rejects(f.jobs.succeedWithCurrentAttempt(f.jobId, current.attemptId, async (scope) => {
      await f.owner.finish(scope, started.identity, 'SUCCEEDED'); throw new Error('AFTER_OWNER_WRITE');
    }), /AFTER_OWNER_WRITE/u);
    assert.deepEqual(await f.rows(), before); assert.equal((await f.jobs.get(f.jobId))?.state, 'RUNNING');
    assert.equal((await f.jobs.attempts(f.jobId))[0]?.status, 'RUNNING');
  } finally { await f.close(); }
});

test('nullable binding migration preserves historical defaults and rejects half bindings', async () => {
  const f = await fixture();
  try {
    const row = (await f.rows())[0]; assert.equal(row?.active_job_attempt_id, null); assert.equal(row?.active_job_attempt_number, null);
    assert.equal((await f.db.query('select requires_owner_recovery from jobs where id=$1', [f.jobId])).rows[0]?.requires_owner_recovery, false);
    assert.equal((await f.db.query('select count(*)::int as count from schema_migrations')).rows[0]?.count, 53);
    await assert.rejects(f.db.query('update media_analysis_runs set active_job_attempt_id=$2 where id=$1', [f.link.runId, 'half-binding']), { code: '23514' });
  } finally { await f.close(); }
});


test('terminal owner validates locked Job project/type metadata, not payload or identity alone', async () => {
  const f = await fixture();
  try {
    const current = await f.claim(); const started = await f.start(current.attemptId); const before = await f.rows();
    const other = await new ProjectService(f.db).create('Different persisted Job owner');
    await f.db.query('update jobs set project_id=$2 where id=$1', [f.jobId, other.id]);
    await assert.rejects(f.jobs.succeedWithCurrentAttempt(f.jobId, current.attemptId, (scope) => f.owner.finish(scope, started.identity, 'SUCCEEDED')), { code: 'MEDIA_ANALYSIS_STALE_OWNER' });
    await f.db.query('update jobs set project_id=$2,type=$3 where id=$1', [f.jobId, f.link.projectId, 'OTHER_TYPE']);
    await assert.rejects(f.jobs.succeedWithCurrentAttempt(f.jobId, current.attemptId, (scope) => f.owner.finish(scope, started.identity, 'SUCCEEDED')), { code: 'MEDIA_ANALYSIS_STALE_OWNER' });
    assert.deepEqual(await f.rows(), before); assert.equal((await f.jobs.get(f.jobId))?.state, 'RUNNING');
  } finally { await f.close(); }
});
