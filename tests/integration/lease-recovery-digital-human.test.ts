import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import type { SpeechProvider } from '../../packages/contracts/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { AssetCatalogService } from '../../packages/modules/asset/src/index.js';
import { DigitalHumanService } from '../../packages/modules/digital-human/src/index.js';
import { JobRunner, JobService } from '../../packages/modules/job/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { createDigitalHumanJobHandler, createDigitalHumanLeaseCancellationHandler, createDigitalHumanLeaseRecoveryHandler, type DigitalHumanWorkerDependencies } from '../../workers/digital-human-worker/src/handler.js';
import { DIGITAL_HUMAN_JOB_TYPES } from '../../workers/digital-human-worker/src/job-types.js';

const speechProvider: SpeechProvider = {
  providerId: 'lease-test-speech',
  getCapabilities: async () => ({ providerId: 'lease-test-speech', local: true, voiceClone: false, emotion: true, speed: true, languages: ['zh'], supportsReferenceAudio: false, requiresReferenceAudio: false, supportsVoiceId: false }),
  generateSpeech: async () => ({ providerId: 'lease-test-speech', model: 'fake-lease-test', modelVersion: '1', outputPath: 'fixture.wav', durationMs: 1_000, latencyMs: 1, provenance: { source: 'FAKE' } }),
};

async function fixture() {
  const url = process.env.CONTENTOS_TEST_DATABASE_URL;
  assert.ok(url, 'explicit isolated test database required');
  assert.equal(new URL(url).pathname, '/contentos_test');
  const admin = await createDatabase(url);
  const schema = `contentos_dh_lease_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`);
  const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
  const db = new pg.Pool({ connectionString: scoped.toString(), max: 4, connectionTimeoutMillis: 2_000 });
  const root = await mkdtemp(join(tmpdir(), 'contentos-dh-lease-'));
  await migrateUp(db);
  const project = await new ProjectService(db).create('Digital Human lease recovery');
  const audioId = `asset-audio-${randomUUID()}`; const videoId = `asset-video-${randomUUID()}`;
  for (const [id, kind, role, format] of [[audioId, 'AUDIO', 'OUTPUT', 'wav'], [videoId, 'VIDEO', 'SOURCE', 'mp4']] as const) {
    await db.query("insert into assets(id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values($1,$2,$3,$4,1,$5,'READY',$6)", [id, project.id, kind, `fixture-${id}`, `fixtures/${id}.${format}`, { durationMs: 1_000, format, width: 640, height: 360 }]);
    await db.query('insert into project_assets(project_id,asset_id,role) values($1,$2,$3)', [project.id, id, role]);
  }
  const jobs = new JobService(db); const assets = new AssetCatalogService(db); const digitalHuman = new DigitalHumanService(db, jobs, assets);
  const voice = await digitalHuman.createVoiceProfile({ projectId: project.id, name: 'Fake lease test voice', provider: speechProvider.providerId, status: 'READY' });
  const speechInput = { projectId: project.id, voiceProfileId: voice.id, text: '连续崩溃恢复测试。', correlationId: 'dh-lease-speech' };
  const speech = await digitalHuman.createSpeechGeneration(speechInput);
  const avatar = await digitalHuman.createAvatarProfile({ projectId: project.id, name: 'Fake lease test avatar', status: 'READY' });
  const clip = await digitalHuman.createAvatarClip({ projectId: project.id, avatarProfileId: avatar.id, assetId: videoId, name: 'Fixture clip' });
  const avatarInput = { projectId: project.id, avatarProfileId: avatar.id, avatarClipId: clip.id, speechAssetId: audioId, provider: 'lease-test-avatar', parameters: { quality: 'fixture' }, correlationId: 'dh-lease-avatar' };
  const generation = await digitalHuman.createAvatarGeneration(avatarInput);
  let submissions = 0; let queries = 0; let imports = 0; let cancellations = 0;
  const deps: DigitalHumanWorkerDependencies = {
    jobs, digitalHuman, assets, storage: new LocalStorageProvider(root), speechProvider,
    assetService: { importFile: async () => { imports += 1; return { id: audioId }; } } as never,
    avatarProvider: { providerId: 'lease-test-avatar', getCapabilities: async () => ({ providerId: 'lease-test-avatar', local: false, videoToVideo: true, imageToVideo: false, requiresPublicUrl: true, supportedFormats: ['mp4'] }), submitLipSync: async () => { submissions += 1; return { externalTaskId: 'existing-remote-task', providerId: 'lease-test-avatar', status: 'RUNNING' }; }, getTask: async (id) => { queries += 1; assert.equal(id, 'existing-remote-task'); return { externalTaskId: id, providerId: 'lease-test-avatar', status: 'RUNNING' }; }, cancelTask: async () => { cancellations += 1; } },
    staging: { stageAsset: async (id) => ({ publicUrl: `https://staging.test/${id}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
  };
  const recover = async () => jobs.reconcileExpiredLeases(new Date(), createDigitalHumanLeaseCancellationHandler(deps), { types: DIGITAL_HUMAN_JOB_TYPES, recover: createDigitalHumanLeaseRecoveryHandler(deps) });
  const expire = async (jobId: string) => db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [jobId]);
  const claim = async (jobId: string, worker: string) => { await jobs.requeue(jobId); const value = await jobs.claim(jobId, worker, 60_000); assert.ok(value); return value; };
  return { db, jobs, digitalHuman, deps, project, speech, speechInput, generation, avatarInput, audioId, recover, expire, claim, counters: () => ({ submissions, queries, imports, cancellations }), close: async () => { await db.end(); await admin.query(`drop schema "${schema}" cascade`); await admin.end(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('contentos-dh-lease-')); await rm(root, { recursive: true, force: true }); } };
}

test('three expired Speech leases atomically fail Job and Generation without allowing direct late completion', async () => {
  const f = await fixture();
  try {
    for (let index = 1; index <= 3; index += 1) {
      const claimed = await f.claim(f.speech.job.id, `speech-crash-${index}`);
      await f.jobs.withCurrentAttemptFence(claimed.job.id, claimed.attemptId, (scope) => f.digitalHuman.markSpeechRunning(f.speech.generation.id, scope));
      await f.expire(claimed.job.id); assert.equal(await f.recover(), 1);
      assert.equal((await f.jobs.get(claimed.job.id))?.state, index === 3 ? 'FAILED' : 'RETRY_WAIT');
      assert.equal((await f.digitalHuman.getSpeechGeneration(f.project.id, f.speech.generation.id))?.status, index === 3 ? 'FAILED' : 'PENDING');
    }
    const job = await f.jobs.get(f.speech.job.id); const generation = await f.digitalHuman.getSpeechGeneration(f.project.id, f.speech.generation.id);
    assert.equal((job?.error as { code: string }).code, 'LEASE_RETRY_EXHAUSTED');
    assert.equal(generation?.error?.code, 'LEASE_RETRY_EXHAUSTED');
    assert.equal(await f.digitalHuman.completeSpeech(f.speech.generation.id, { outputAssetId: f.audioId, durationMs: 1_000, latencyMs: 1, modelVersion: 'late', provenance: {} }), false);
    assert.equal(await f.recover(), 0); assert.equal(await f.jobs.claim(f.speech.job.id, 'must-not-run', 60_000), null);
  } finally { await f.close(); }
});

test('Digital Human owner recovery and cancellation reject a different Job or attempt scope before writing', async () => {
  const f = await fixture();
  try {
    const claimed = await f.claim(f.speech.job.id, 'wrong-scope');
    const before = await f.digitalHuman.getSpeechGeneration(f.project.id, f.speech.generation.id);
    const result = await f.jobs.withCurrentAttemptFence(claimed.job.id, claimed.attemptId, async (scope) => {
      for (const mismatched of [{ ...claimed.job, id: 'different-job' }, { ...claimed.job, attemptCount: claimed.job.attemptCount + 1 }]) {
        assert.equal(await f.digitalHuman.recoverGenerationLease(mismatched, scope, { outcome: 'FAILED', consecutiveFailures: 3, limit: 3, error: { code: 'LEASE_RETRY_EXHAUSTED', message: 'fixture' } }), false);
        assert.equal(await f.digitalHuman.cancelGenerationForJob(mismatched, scope), false);
      }
    });
    assert.equal(result.executed, true); assert.deepEqual(await f.digitalHuman.getSpeechGeneration(f.project.id, f.speech.generation.id), before);
  } finally { await f.close(); }
});

test('Avatar remote pending defers exceed maxAttempts one without spending crash recovery budget or submitting twice', async () => {
  const f = await fixture();
  try {
    await f.db.query('update jobs set max_attempts=1 where id=$1', [f.generation.job.id]);
    for (let index = 0; index < 6; index += 1) {
      await f.jobs.requeue(f.generation.job.id);
      const result = await new JobRunner(f.jobs, `pending-${index}`).run(f.generation.job.id, createDigitalHumanJobHandler(f.deps));
      assert.equal(result.state, 'RETRY_WAIT'); assert.equal(await f.recover(), 0);
      assert.equal((await f.digitalHuman.getAvatarGeneration(f.project.id, f.generation.generation.id))?.externalTaskId, 'existing-remote-task');
      assert.equal((await f.digitalHuman.getAvatarGeneration(f.project.id, f.generation.generation.id))?.status, 'WAITING_EXTERNAL');
    }
    const owner = await f.digitalHuman.getAvatarGeneration(f.project.id, f.generation.generation.id);
    assert.deepEqual(owner?.provenance.parameters, { quality: 'fixture' });
    assert.deepEqual(f.counters(), { submissions: 1, queries: 5, imports: 0, cancellations: 0 });
    // Healthy remote waiting must not make the next crash look like the sixth loss.
    const claimed = await f.claim(f.generation.job.id, 'one-real-crash'); await f.expire(claimed.job.id); assert.equal(await f.recover(), 1);
    assert.equal((await f.jobs.get(claimed.job.id))?.state, 'RETRY_WAIT');
  } finally { await f.close(); }
});

test('exhausted Avatar keeps remote task provenance and explicit retry queries that task before considering submission', async () => {
  const f = await fixture();
  try {
    assert.equal((await new JobRunner(f.jobs, 'submit-once').run(f.generation.job.id, createDigitalHumanJobHandler(f.deps))).state, 'RETRY_WAIT');
    for (let index = 1; index <= 3; index += 1) {
      const claimed = await f.claim(f.generation.job.id, `avatar-crash-${index}`); await f.expire(claimed.job.id); assert.equal(await f.recover(), 1);
    }
    const exhausted = await f.digitalHuman.getAvatarGeneration(f.project.id, f.generation.generation.id);
    assert.equal(exhausted?.status, 'FAILED'); assert.equal(exhausted?.externalTaskId, 'existing-remote-task'); assert.deepEqual(exhausted?.provenance.parameters, { quality: 'fixture' });
    assert.equal(exhausted?.error?.code, 'LEASE_RETRY_EXHAUSTED'); assert.equal(f.counters().cancellations, 0);
    assert.equal(await f.digitalHuman.completeAvatar(f.generation.generation.id, { outputAssetId: f.audioId }), false);
    const retry = await f.digitalHuman.createAvatarGeneration(f.avatarInput);
    assert.equal(retry.created, false); assert.equal(retry.job.state, 'QUEUED'); assert.equal(retry.generation.externalTaskId, 'existing-remote-task');
    assert.equal((await new JobRunner(f.jobs, 'explicit-retry').run(retry.job.id, createDigitalHumanJobHandler(f.deps))).state, 'RETRY_WAIT');
    assert.deepEqual(f.counters(), { submissions: 1, queries: 1, imports: 0, cancellations: 0 });
  } finally { await f.close(); }
});

for (const outcome of ['return', 'throw'] as const) {
  test(`Speech provider ignoring abort cannot ${outcome} into an exhausted Generation`, { timeout: 20_000 }, async () => {
    const f = await fixture(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    const slow: SpeechProvider = { ...speechProvider, generateSpeech: async (request) => { entered(); await gate; if (outcome === 'throw') throw new Error('late fake provider error'); return speechProvider.generateSpeech(request); } };
    const running = new JobRunner(f.jobs, 'obsolete-speech', 60_000).run(f.speech.job.id, createDigitalHumanJobHandler({ ...f.deps, speechProvider: slow }));
    try {
      await started; await f.expire(f.speech.job.id); assert.equal(await f.recover(), 1);
      for (let index = 2; index <= 3; index += 1) { const claimed = await f.claim(f.speech.job.id, `replacement-${index}`); await f.expire(claimed.job.id); assert.equal(await f.recover(), 1); }
      const before = await f.digitalHuman.getSpeechGeneration(f.project.id, f.speech.generation.id);
      release(); const result = await running; assert.equal(result.state, 'FAILED');
      const after = await f.digitalHuman.getSpeechGeneration(f.project.id, f.speech.generation.id);
      assert.equal(after?.status, 'FAILED'); assert.equal(after?.outputAssetId, null); assert.deepEqual(after?.error, before?.error); assert.equal(after?.updatedAt, before?.updatedAt);
      assert.equal((await f.jobs.get(f.speech.job.id))?.state, 'FAILED');
    } finally { release(); await running; await f.close(); }
  });
}

test('obsolete Avatar provider completion cannot overwrite exhaustion or cancel the preserved external task', { timeout: 20_000 }, async () => {
  const f = await fixture(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  await f.db.query("update avatar_generations set external_task_id='existing-remote-task' where id=$1", [f.generation.generation.id]);
  const deps: DigitalHumanWorkerDependencies = { ...f.deps, avatarProvider: { ...f.deps.avatarProvider, getTask: async (id) => { entered(); await gate; return { externalTaskId: id, providerId: 'lease-test-avatar', status: 'SUCCEEDED', outputUrl: 'https://provider.test/result.mp4' }; } }, fetchImpl: async () => new Response(Buffer.from('fake video fixture'), { headers: { 'content-type': 'video/mp4' } }), resolveRemoteMedia: async () => [{ address: '93.184.216.34', family: 4 }], probeRemoteResult: async () => ({ format: 'mp4', durationMs: 1_000, width: 640, height: 360, videoCodec: 'h264' }) };
  const running = new JobRunner(f.jobs, 'obsolete-avatar', 60_000).run(f.generation.job.id, createDigitalHumanJobHandler(deps));
  try {
    await started; await f.expire(f.generation.job.id); assert.equal(await f.recover(), 1);
    for (let index = 2; index <= 3; index += 1) { const claimed = await f.claim(f.generation.job.id, `avatar-replacement-${index}`); await f.expire(claimed.job.id); assert.equal(await f.recover(), 1); }
    const before = await f.digitalHuman.getAvatarGeneration(f.project.id, f.generation.generation.id);
    release(); assert.equal((await running).state, 'FAILED');
    assert.deepEqual(await f.digitalHuman.getAvatarGeneration(f.project.id, f.generation.generation.id), before);
    assert.equal(f.counters().submissions, 0); assert.equal(f.counters().cancellations, 0);
  } finally { release(); await running; await f.close(); }
});

test('Digital Human owner recovery rolls back when its callback fails after mutating the Generation', async () => {
  const f = await fixture();
  try {
    const claimed = await f.claim(f.speech.job.id, 'rollback-crash'); await f.digitalHuman.markSpeechRunning(f.speech.generation.id); await f.expire(claimed.job.id);
    const before = await f.digitalHuman.getSpeechGeneration(f.project.id, f.speech.generation.id);
    assert.equal(await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: DIGITAL_HUMAN_JOB_TYPES, recover: async (job, scope, context) => { assert.equal(await f.digitalHuman.recoverGenerationLease(job, scope, context), true); throw new Error('fixture owner rollback'); } }), 0);
    assert.equal((await f.jobs.get(claimed.job.id))?.state, 'RUNNING'); assert.deepEqual(await f.digitalHuman.getSpeechGeneration(f.project.id, f.speech.generation.id), before);
    assert.equal(await f.recover(), 1);
  } finally { await f.close(); }
});

test('expired cancelled Avatar lease commits owner and Job cancellation without remote I/O', async () => {
  const f = await fixture();
  try {
    const claimed = await f.claim(f.generation.job.id, 'cancelled-avatar');
    await f.jobs.withCurrentAttemptFence(claimed.job.id, claimed.attemptId, async (scope) => {
      await f.digitalHuman.markAvatarRunning(f.generation.generation.id, scope);
      await f.digitalHuman.markAvatarWaiting(f.generation.generation.id, 'existing-remote-task', { marker: 'retain' }, scope);
    });
    await f.jobs.requestCancel(claimed.job.id); await f.expire(claimed.job.id); assert.equal(await f.recover(), 1);
    const owner = await f.digitalHuman.getAvatarGeneration(f.project.id, f.generation.generation.id);
    assert.equal((await f.jobs.get(claimed.job.id))?.state, 'CANCELLED'); assert.equal(owner?.status, 'CANCELLED');
    assert.equal(owner?.externalTaskId, 'existing-remote-task'); assert.equal(owner?.provenance.marker, 'retain'); assert.equal(f.counters().cancellations, 0);
  } finally { await f.close(); }
});

test('Avatar cancellation at the pending boundary atomically cancels Generation before remote cancellation outside transaction', async () => {
  const f = await fixture();
  try {
    const fence = f.jobs.withCurrentAttemptFence.bind(f.jobs);
    let writes = 0; let inCancellationTransaction = false;
    f.jobs.withCurrentAttemptFence = async (id, attemptId, action) => { const result = await fence(id, attemptId, action); if (++writes === 2) await f.jobs.requestCancel(id); return result; };
    const cancelOwner = f.digitalHuman.cancelGenerationForJob.bind(f.digitalHuman);
    f.digitalHuman.cancelGenerationForJob = async (job, scope) => { inCancellationTransaction = true; try { return await cancelOwner(job, scope); } finally { inCancellationTransaction = false; } };
    const cancelRemote = f.deps.avatarProvider.cancelTask!;
    f.deps.avatarProvider.cancelTask = async (id) => { assert.equal(inCancellationTransaction, false); const committed = await f.digitalHuman.getAvatarGeneration(f.project.id, f.generation.generation.id); assert.equal(committed?.status, 'CANCELLED'); assert.equal((await f.jobs.get(f.generation.job.id))?.state, 'CANCELLED'); return cancelRemote(id); };
    const result = await new JobRunner(f.jobs, 'pending-boundary-cancel').run(f.generation.job.id, createDigitalHumanJobHandler(f.deps));
    const owner = await f.digitalHuman.getAvatarGeneration(f.project.id, f.generation.generation.id);
    assert.equal(result.state, 'CANCELLED'); assert.equal(owner?.status, 'CANCELLED'); assert.equal(owner?.externalTaskId, 'existing-remote-task'); assert.deepEqual(owner?.provenance.parameters, { quality: 'fixture' });
    assert.equal(f.counters().cancellations, 1); assert.equal(f.counters().submissions, 1);
  } finally { await f.close(); }
});

test('historical successful Digital Human owner is preserved and expired Job is blocked for reconciliation', async () => {
  const f = await fixture();
  try {
    const claimed = await f.claim(f.speech.job.id, 'legacy-success');
    assert.equal(await f.digitalHuman.completeSpeech(f.speech.generation.id, { outputAssetId: f.audioId, durationMs: 1_000, latencyMs: 1, modelVersion: 'legacy', provenance: { source: 'FAKE' } }), true);
    const before = await f.digitalHuman.getSpeechGeneration(f.project.id, f.speech.generation.id); await f.expire(claimed.job.id); assert.equal(await f.recover(), 1);
    for (let index = 2; index <= 3; index += 1) { const next = await f.claim(f.speech.job.id, `legacy-loss-${index}`); await f.expire(next.job.id); assert.equal(await f.recover(), 1); }
    assert.equal((await f.jobs.get(claimed.job.id))?.state, 'BLOCKED'); assert.deepEqual(await f.digitalHuman.getSpeechGeneration(f.project.id, f.speech.generation.id), before);
    assert.equal(await f.jobs.claim(claimed.job.id, 'blocked-worker', 60_000), null);
  } finally { await f.close(); }
});

test('Digital Human success and owner output roll back together when Job commit is rejected', async () => {
  const f = await fixture();
  try {
    await f.db.query('update jobs set max_attempts=1 where id=$1', [f.speech.job.id]);
    await f.db.query("create function reject_dh_job_success() returns trigger language plpgsql as $$ begin if new.state='SUCCEEDED' then raise exception 'fixture rejects success'; end if; return new; end $$");
    await f.db.query('create trigger reject_dh_job_success before update on jobs for each row execute function reject_dh_job_success()');
    const result = await new JobRunner(f.jobs, 'atomic-dh').run(f.speech.job.id, createDigitalHumanJobHandler(f.deps));
    assert.equal(result.state, 'FAILED');
    const owner = await f.digitalHuman.getSpeechGeneration(f.project.id, f.speech.generation.id);
    assert.equal(owner?.status, 'FAILED'); assert.equal(owner?.outputAssetId, null); assert.equal(owner?.modelVersion, null);
    assert.equal((await f.db.query("select id from job_events where job_id=$1 and event_type='job.succeeded'", [f.speech.job.id])).rowCount, 0);
  } finally { await f.close(); }
});
