import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { JobService, JobRunner } from '../../packages/modules/job/src/index.js';
import { MediaIntelligenceService, createFakeIntelligenceProviders } from '../../packages/modules/intelligence/src/index.js';
import { createMediaAnalysisJobHandler } from '../../workers/media-intelligence-worker/src/handler.js';

async function fixture() {
  const url = process.env.CONTENTOS_TEST_DATABASE_URL;
  assert.ok(url, 'explicit isolated test database required');
  assert.equal(new URL(url).pathname, '/contentos_test');
  const admin = await createDatabase(url);
  const schema = `contentos_fence_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`);
  const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
  const db = new pg.Pool({ connectionString: scoped.toString(), max: 2, connectionTimeoutMillis: 2_000 });
  await migrateUp(db);
  const project = await new ProjectService(db).create('Analysis attempt fencing');
  const assetId = `asset-${randomUUID()}`;
  await db.query("insert into assets(id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values($1,$2,'VIDEO','fixture-checksum',1,'fixture.mp4','READY',$3)", [assetId, project.id, { durationMs: 1_000, width: 640, height: 360 }]);
  const jobs = new JobService(db);
  const intelligence = new MediaIntelligenceService(db, createFakeIntelligenceProviders());
  const run = await intelligence.createRun({ projectId: project.id, assetId, capabilities: ['TECHNICAL', 'SHOTS', 'ASR', 'VISION', 'EMBEDDING'] });
  const jobId = `job-${randomUUID()}`;
  await jobs.create({ id: jobId, type: 'MEDIA_ANALYSIS', projectId: project.id, idempotencyKey: jobId, maxAttempts: 3, payload: { schemaVersion: 'MEDIA_ANALYSIS_JOB_V1', projectId: project.id, assetId, runId: run.id, correlationId: `corr-${run.id}` } });
  await intelligence.attachJob(run.id, jobId);
  return { db, jobs, intelligence, project, assetId, run, jobId, close: async () => { await db.end(); await admin.query(`drop schema "${schema}" cascade`); await admin.end(); } };
}

test('successful replacement analysis removes obsolete ASR and vision rows and embeddings', async () => {
  const f = await fixture();
  try {
    const partial = createFakeIntelligenceProviders();
    // Seed results through the real analysis pipeline, then fail after vision persistence.
    const embed = createFakeIntelligenceProviders().embedding.embed;
    let calls = 0;
    partial.embedding.embed = async (input) => { calls += 1; if (calls > 1) throw new Error('retry after derived rows'); return embed(input); };
    const first = new MediaIntelligenceService(f.db, partial);
    assert.equal((await new JobRunner(f.jobs, 'partial-analysis').run(f.jobId, createMediaAnalysisJobHandler({ jobs: f.jobs, intelligence: first }))).state, 'RETRY_WAIT');
    const before = await f.intelligence.results(f.project.id, f.run.id);
    assert.ok(before.asr.length > 0);
    assert.ok(before.vision.length > 0);
    await f.jobs.requeue(f.jobId);
    const replacementProviders = createFakeIntelligenceProviders();
    replacementProviders.asr.transcribe = async () => [];
    replacementProviders.vision.analyze = async () => [];
    const replacement = new MediaIntelligenceService(f.db, replacementProviders);
    assert.equal((await new JobRunner(f.jobs, 'replacement-analysis').run(f.jobId, createMediaAnalysisJobHandler({ jobs: f.jobs, intelligence: replacement }))).state, 'SUCCEEDED');
    const after = await replacement.results(f.project.id, f.run.id);
    assert.deepEqual(after.asr, []);
    assert.deepEqual(after.vision, []);
    assert.equal((await f.db.query("select 1 from media_analysis_embeddings where run_id=$1 and content_type in ('ASR','VISION')", [f.run.id])).rowCount, 0);
  } finally { await f.close(); }
});

for (const outcome of ['return', 'throw'] as const) {
  test(`late analysis provider ${outcome} cannot overwrite a replacement attempt`, { timeout: 20_000 }, async () => {
    const f = await fixture();
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void; const entered = new Promise<void>((resolve) => { started = resolve; });
    const slow = createFakeIntelligenceProviders(); const probe = slow.technical.probe.bind(slow.technical);
    slow.technical.probe = async (input) => { started(); await gate; if (outcome === 'throw') throw new Error('late provider failure'); return { ...await probe(input), width: 999 }; };
    const staleService = new MediaIntelligenceService(f.db, slow);
    const running = new JobRunner(f.jobs, 'old-worker', 60_000).run(f.jobId, createMediaAnalysisJobHandler({ jobs: f.jobs, intelligence: staleService }));
    try {
      await entered;
      await f.db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [f.jobId]);
      assert.equal(await f.jobs.reconcileExpiredLeases(), 1);
      await f.jobs.requeue(f.jobId);
      const replacement = await new JobRunner(f.jobs, 'new-worker').run(f.jobId, createMediaAnalysisJobHandler(f));
      assert.equal(replacement.state, 'SUCCEEDED');
      const before = await f.intelligence.results(f.project.id, f.run.id);
      release(); await running;
      const after = await f.intelligence.results(f.project.id, f.run.id);
      assert.equal(after.run.status, 'SUCCEEDED');
      assert.equal(after.technical?.width, before.technical?.width);
      assert.equal(after.run.finishedAt, before.run.finishedAt);
      assert.deepEqual(after.shots, before.shots);
      assert.equal((await f.jobs.get(f.jobId))?.state, 'SUCCEEDED');
    } finally { release(); await running; await f.close(); }
  });
}

test('analysis worker validates persisted run linkage before provider execution', async () => {
  const f = await fixture();
  try {
    await f.db.query('update media_analysis_runs set job_id=null where id=$1', [f.run.id]);
    let calls = 0; const providers = createFakeIntelligenceProviders();
    providers.technical.probe = async () => { calls += 1; throw new Error('must not call provider'); };
    const intelligence = new MediaIntelligenceService(f.db, providers);
    const result = await new JobRunner(f.jobs, 'link-check').run(f.jobId, createMediaAnalysisJobHandler({ jobs: f.jobs, intelligence }));
    assert.equal(result.state, 'FAILED'); assert.equal(calls, 0);
    assert.equal((await intelligence.getRun(f.project.id, f.run.id))?.status, 'QUEUED');
  } finally { await f.close(); }
});

test('analysis and Job success roll back together when final Job persistence fails', async () => {
  const f = await fixture();
  try {
    await f.db.query("create function veto_analysis_success() returns trigger language plpgsql as $$ begin if new.event_type='job.succeeded' then raise exception 'success persistence veto'; end if; return new; end $$");
    await f.db.query('create trigger veto_success before insert on job_events for each row execute function veto_analysis_success()');
    const result = await new JobRunner(f.jobs, 'atomic-completion').run(f.jobId, createMediaAnalysisJobHandler(f));
    assert.equal(result.state, 'RETRY_WAIT');
    assert.equal((await f.intelligence.getRun(f.project.id, f.run.id))?.status, 'FAILED');
    assert.equal((await f.db.query("select 1 from job_events where job_id=$1 and event_type='job.succeeded'", [f.jobId])).rowCount, 0);
  } finally { await f.close(); }
});

test('active cancellation commits the analysis and Job together even when provider ignores abort', async () => {
  const f = await fixture();
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void; const entered = new Promise<void>((resolve) => { started = resolve; });
  const providers = createFakeIntelligenceProviders(); const probe = providers.technical.probe.bind(providers.technical);
  providers.technical.probe = async (input) => { started(); await gate; return probe(input); };
  const intelligence = new MediaIntelligenceService(f.db, providers);
  const running = new JobRunner(f.jobs, 'cancel-worker', 60_000).run(f.jobId, createMediaAnalysisJobHandler({ jobs: f.jobs, intelligence }));
  try {
    await entered; await f.jobs.requestCancel(f.jobId); release();
    assert.equal((await running).state, 'CANCELLED');
    assert.equal((await intelligence.getRun(f.project.id, f.run.id))?.status, 'CANCELLED');
    assert.equal((await f.db.query('select 1 from media_analysis_technical where run_id=$1', [f.run.id])).rowCount, 0);
  } finally { release(); await running; await f.close(); }
});

test('inactive Job recovery fence rejects a newer claim and rolls owner writes back on error', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.jobs.withInactiveJobFence(f.jobId, { type: 'MEDIA_ANALYSIS', projectId: f.project.id, attemptCount: 0, state: 'QUEUED' }, async (scope) => {
      await scope.query("update media_analysis_runs set status='FAILED' where id=$1", [f.run.id]);
      throw new Error('owner veto');
    }), /owner veto/);
    assert.equal((await f.intelligence.getRun(f.project.id, f.run.id))?.status, 'QUEUED');
    await f.jobs.claim(f.jobId, 'new-claim', 30_000);
    let called = false;
    const result = await f.jobs.withInactiveJobFence(f.jobId, { type: 'MEDIA_ANALYSIS', projectId: f.project.id, attemptCount: 0, state: 'QUEUED' }, async () => { called = true; });
    assert.equal(result.executed, false); assert.equal(called, false);
  } finally { await f.close(); }
});

test('crashed analysis recovery uses durable Job state and resumes successfully', async () => {
  const f = await fixture();
  try {
    await f.jobs.claim(f.jobId, 'crashed-worker', 30_000);
    await f.db.query("update media_analysis_runs set status='RUNNING',attempt_count=1 where id=$1", [f.run.id]);
    await f.db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [f.jobId]);
    assert.equal(await f.jobs.reconcileExpiredLeases(), 1);
    assert.equal(await f.intelligence.reconcileStaleRuns(), 1);
    assert.equal((await f.intelligence.getRun(f.project.id, f.run.id))?.status, 'QUEUED');
    await f.jobs.requeue(f.jobId);
    const result = await new JobRunner(f.jobs, 'recovered-worker').run(f.jobId, createMediaAnalysisJobHandler(f));
    assert.equal(result.state, 'SUCCEEDED');
    assert.equal((await f.intelligence.getRun(f.project.id, f.run.id))?.status, 'SUCCEEDED');
  } finally { await f.close(); }
});

test('pre-provider configuration failure settles the linked analysis and Job', async () => {
  const f = await fixture();
  try {
    await f.db.query("update media_analysis_runs set provider_mode='REAL' where id=$1", [f.run.id]);
    const result = await new JobRunner(f.jobs, 'invalid-mode-worker').run(f.jobId, createMediaAnalysisJobHandler(f));
    assert.equal(result.state, 'FAILED');
    assert.equal((await f.intelligence.getRun(f.project.id, f.run.id))?.status, 'FAILED');
  } finally { await f.close(); }
});
