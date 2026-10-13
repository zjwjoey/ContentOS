import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { AssetCatalogService, AssetImportService, AssetService, LocalMediaSourceService } from '../../packages/modules/asset/src/index.js';
import { JobRunner, JobService, type JobAttemptScope, type JobLeaseRecoveryHandler, type JobRecord } from '../../packages/modules/job/src/index.js';
import { buildVideoManifest, digestEditManifest, ensureStandaloneWorkspace, HybridMediaService, VideoService } from '../../packages/modules/video/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { generateFixtureVideo, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { createAssetJobHandler, createAssetLeaseRecoveryHandler } from '../../workers/asset-worker/src/asset-handler.js';
import { createVideoLeaseRecoveryHandler, VIDEO_JOB_TYPES } from '../../workers/video-worker/src/lease-recovery.js';
import { createVideoWorker } from '../../workers/video-worker/src/main.js';
import { createEditPrepareJobHandler } from '../../workers/video-worker/src/video-handler.js';

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';

async function fixture() {
  const url = process.env.CONTENTOS_TEST_DATABASE_URL;
  assert.ok(url, 'explicit isolated test database required');
  assert.equal(new URL(url).pathname, '/contentos_test');
  const admin = await createDatabase(url);
  const schema = `contentos_lease_owners_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`);
  const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
  const db = new pg.Pool({ connectionString: scoped.toString(), max: 2, connectionTimeoutMillis: 2_000 });
  await migrateUp(db);
  const root = await mkdtemp(join(tmpdir(), 'contentos-lease-owners-'));
  const storage = new LocalStorageProvider(root);
  const project = await new ProjectService(db).create('Lease owner recovery');
  await db.query("insert into video_workspaces(id,type,project_id) values($1,'PROJECT',$2) on conflict do nothing", [`workspace-project-${project.id}`, project.id]);
  const workspaceId = `workspace-${randomUUID()}`;
  await ensureStandaloneWorkspace(db, workspaceId);
  const snapshotId = `snapshot-${randomUUID()}`;
  await db.query('insert into material_pool_snapshots(id,workspace_id,revision) values($1,$2,1)', [snapshotId, workspaceId]);
  const jobs = new JobService(db);
  const imports = new AssetImportService(db);
  const assets = new AssetService(db, storage, (path) => probeMedia(path, ffprobePath));
  const video = new VideoService(db, storage, jobs, new AssetCatalogService(db));
  const localMedia = new LocalMediaSourceService({ db });
  const assetRecovery = createAssetLeaseRecoveryHandler(imports);
  const videoRecovery = createVideoLeaseRecoveryHandler({ video, localMedia });
  async function makeJob(type: string, payload: unknown, projectOwned = false) {
    const id = `job-${randomUUID()}`;
    return jobs.create({ id, type, projectId: projectOwned ? project.id : null, workspaceId: projectOwned ? null : workspaceId, payload, idempotencyKey: id, maxAttempts: 1 });
  }
  async function lose(job: JobRecord, recover: JobLeaseRecoveryHandler, start?: (scope: JobAttemptScope) => Promise<unknown>) {
    const claimed = await jobs.claim(job.id, 'crashed-fixture-worker', 30_000);
    assert.ok(claimed);
    if (start) assert.equal((await jobs.withCurrentAttemptFence(job.id, claimed.attemptId, start)).executed, true);
    await db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [job.id]);
    assert.equal(await jobs.reconcileExpiredLeases(new Date(), undefined, { types: [job.type], recover }), 1);
    return claimed;
  }
  async function assertBlockedStable(job: JobRecord, recover: JobLeaseRecoveryHandler) {
    assert.equal((await jobs.get(job.id))?.state, 'BLOCKED');
    assert.equal(await jobs.claim(job.id, 'must-not-replay-refused-owner', 30_000), null);
    for (let scan = 0; scan < 2; scan += 1) assert.equal(await jobs.reconcileExpiredLeases(new Date(), undefined, { types: [job.type], recover }), 0);
    assert.equal((await jobs.get(job.id))?.attemptCount, 1);
    assert.equal((await db.query('select consecutive_lease_failures from jobs where id=$1', [job.id])).rows[0].consecutive_lease_failures, 1);
    assert.equal((await jobs.attempts(job.id)).length, 1);
    assert.equal((await db.query("select count(*)::int as count from job_events where job_id=$1 and event_type='job.lease_retry_exhausted'", [job.id])).rows[0].count, 0);
  }
  async function makeImport(projectOwned: boolean, realMedia = false) {
    await mkdir(join(root, 'staging'), { recursive: true });
    const stagedPath = `staging/${randomUUID()}.part`;
    if (realMedia) { const mediaPath = join(root, `${randomUUID()}.mp4`); await generateFixtureVideo(mediaPath, ffmpegPath, 'blue', 1); await writeFile(storage.stagedPath(stagedPath), await readFile(mediaPath)); }
    else await writeFile(storage.stagedPath(stagedPath), 'preserved staged fixture');
    const imported = await imports.createStaged({ ...(projectOwned ? { projectId: project.id } : { workspaceId }), originalName: 'lease.mp4', kind: 'VIDEO', byteSize: (await readFile(storage.stagedPath(stagedPath))).length, stagedPath, correlationId: 'lease-owner-fixture' });
    const job = await makeJob('ASSET_IMPORT', { schemaVersion: 'ASSET_IMPORT_V0', ...(projectOwned ? { projectId: project.id } : { workspaceId }), importId: imported.id }, projectOwned);
    if (projectOwned) await imports.attachJob(project.id, imported.id, job.id); else await imports.attachWorkspaceJob(workspaceId, imported.id, job.id);
    const start = (scope: JobAttemptScope) => projectOwned ? imports.markProcessing(project.id, imported.id, scope) : imports.markWorkspaceProcessing(workspaceId, imported.id, scope);
    const get = () => projectOwned ? imports.get(project.id, imported.id) : imports.getWorkspace(workspaceId, imported.id);
    return { imported, job, start, get };
  }
  async function makeBatch(job: JobRecord, prepare: boolean) {
    const sessionId = `workbench-${randomUUID()}`; const batchId = `batch-${randomUUID()}`; const itemId = `item-${randomUUID()}`;
    await db.query("insert into edit_workbench_sessions(id,mode,title) values($1,'MIX','Lease fixture')", [sessionId]);
    await db.query("insert into edit_batches(id,session_id,mode,status,total_count) values($1,$2,'MIX','RUNNING',1)", [batchId, sessionId]);
    await db.query(`insert into edit_batch_items(id,batch_id,ordinal,title,script,workspace_id,state,job_id,prepare_job_id)
      values($1,$2,1,'Lease fixture','Fixture script',$3,$4,$5,$6)`, [itemId, batchId, workspaceId, prepare ? 'PREPARING' : 'RENDERING', prepare ? null : job.id, prepare ? job.id : null]);
    return { batchId, itemId };
  }
  async function makeRender(withOwners = false) {
    const manifestId = `manifest-${randomUUID()}`; const renderId = `render-${randomUUID()}`; const planId = randomUUID(); const sessionId = `v3-${randomUUID()}`;
    const manifest = buildVideoManifest({ workspaceId, seed: 1, targetDurationMs: 1_000, assets: [{ id: 'fixture-asset', storageKey: 'fixture', sourcePath: join(root, 'fixture.mp4'), durationMs: 1_000 }], ...(withOwners ? { metadata: { editorialPlanId: planId, v3SessionId: sessionId } } : {}) });
    await db.query("insert into edit_manifests(id,workspace_id,revision,schema_version,manifest,manifest_digest,status) values($1,$2,1,'EDIT_MANIFEST_V0',$3,$4,'PERSISTED')", [manifestId, workspaceId, manifest, digestEditManifest(manifest)]);
    const job = await makeJob('VIDEO_RENDER', { workspaceId, manifestId });
    await db.query("insert into renders(id,workspace_id,manifest_id,job_id,status) values($1,$2,$3,$4,'QUEUED')", [renderId, workspaceId, manifestId, job.id]);
    if (withOwners) {
      await db.query("insert into edit_script_plans(id,workspace_id,script,status,current_manifest_id) values($1,$2,'fixture','RENDERING',$3)", [planId, workspaceId, manifestId]);
      await db.query("insert into script_editing_v3_sessions(id,workspace_id,material_pool_snapshot_id,script,status,current_manifest_id) values($1,$2,$3,'fixture','RENDERING',$4)", [sessionId, workspaceId, snapshotId, manifestId]);
    }
    return { job, manifestId, renderId, planId, sessionId, start: (scope: JobAttemptScope) => video.startRender(renderId, scope) };
  }
  return { db, jobs, imports, assets, video, storage, localMedia, project, workspaceId, snapshotId, root, makeJob, makeImport, makeBatch, makeRender, lose, assertBlockedStable, assetRecovery, videoRecovery,
    close: async () => { await db.end(); assert.match(schema, /^contentos_lease_owners_[a-f0-9]{32}$/u); await admin.query(`drop schema "${schema}" cascade`); await admin.end(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('contentos-lease-owners-')); await rm(root, { recursive: true, force: true }); } };
}

test('Asset lease retry restores PROCESSING and successfully imports the same real staged media', async () => {
  const f = await fixture();
  try {
    const i = await f.makeImport(true, true);
    await f.lose(i.job, f.assetRecovery, i.start);
    assert.equal((await i.get())?.state, 'QUEUED');
    await access(f.storage.stagedPath(i.imported.stagedPath));
    const result = await new JobRunner(f.jobs, 'replacement-asset').run(i.job.id, createAssetJobHandler({ db: f.db, jobs: f.jobs, imports: f.imports, assets: f.assets, storage: f.storage, ffprobePath }));
    assert.equal(result.state, 'SUCCEEDED'); assert.equal((await i.get())?.state, 'READY'); assert.equal(result.attemptCount, 2);
    assert.equal((await f.db.query('select metadata from assets where id=$1', [(await i.get())?.outputAssetId])).rows[0].metadata.originalName, 'lease.mp4');
  } finally { await f.close(); }
});

test('Asset owner recovery refuses confirmed successful output and mismatched import linkage', async () => {
  const f = await fixture();
  try {
    const i = await f.makeImport(true);
    const claim = await f.jobs.claim(i.job.id, 'already-finished-owner', 30_000); assert.ok(claim);
    await f.jobs.withCurrentAttemptFence(i.job.id, claim.attemptId, i.start);
    const outputId = `asset-${randomUUID()}`;
    await f.db.query("insert into assets(id,project_id,kind,checksum,byte_size,storage_key,lifecycle) values($1,$2,'VIDEO','fixture-ready',1,'fixture-output','READY')", [outputId, f.project.id]);
    await f.imports.complete(f.project.id, i.imported.id, { outputAssetId: outputId, state: 'READY' });
    await f.db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [i.job.id]);
    assert.equal(await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['ASSET_IMPORT'], recover: f.assetRecovery }), 1);
    await f.assertBlockedStable(i.job, f.assetRecovery);
    assert.equal((await f.jobs.get(i.job.id))?.state, 'BLOCKED'); assert.equal((await i.get())?.state, 'READY'); assert.equal((await i.get())?.outputAssetId, outputId);
    const foreign = await f.makeJob('ASSET_IMPORT', { schemaVersion: 'ASSET_IMPORT_V0', workspaceId: f.workspaceId, importId: i.imported.id });
    await f.lose(foreign, f.assetRecovery); await f.assertBlockedStable(foreign, f.assetRecovery);
    assert.equal((await f.jobs.get(foreign.id))?.state, 'BLOCKED'); assert.equal((await i.get())?.state, 'READY');
  } finally { await f.close(); }
});

test('preserved Asset preparation rejects changed bytes without deleting its original input', async () => {
  const f = await fixture();
  try {
    const i = await f.makeImport(false);
    await assert.rejects(f.assets.prepareStagedUpload({ workspaceId: f.workspaceId, sourcePath: f.storage.stagedPath(i.imported.stagedPath), kind: 'VIDEO', stagedPath: i.imported.stagedPath, originalName: 'lease.mp4', checksum: `sha256:${'0'.repeat(64)}`, byteSize: i.imported.byteSize, preserveStagedInput: true }), { code: 'ASSET_STAGED_INPUT_CHANGED' });
    await access(f.storage.stagedPath(i.imported.stagedPath));
    assert.deepEqual(await readdir(join(f.root, 'staging')), [basename(i.imported.stagedPath)]);
    assert.deepEqual(await f.storage.listObjectKeys(), []);
  } finally { await f.close(); }
});

test('preserved Asset promotion uses verified copied bytes rather than stale stage metadata', async () => {
  const f = await fixture();
  try {
    const i = await f.makeImport(false); const bytes = await readFile(f.storage.stagedPath(i.imported.stagedPath)); const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const nativeStage = f.storage.stage.bind(f.storage);
    f.storage.stage = async (source) => ({ ...await nativeStage(source), checksum: 'f'.repeat(64), byteSize: 999, originalName: 'wrong.part' });
    const prepared = await f.assets.prepareStagedUpload({ workspaceId: f.workspaceId, sourcePath: f.storage.stagedPath(i.imported.stagedPath), kind: 'VIDEO', stagedPath: i.imported.stagedPath, originalName: 'lease.mp4', checksum, byteSize: bytes.length, preserveStagedInput: true });
    assert.equal(prepared.checksum, checksum); assert.equal(prepared.byteSize, bytes.length); assert.equal(prepared.originalName, 'lease.mp4');
    assert.ok(prepared.storageKey.endsWith(checksum.slice('sha256:'.length))); assert.deepEqual(await readFile(f.storage.objectPath(prepared.storageKey)), bytes);
    await access(f.storage.stagedPath(i.imported.stagedPath));
  } finally { await f.close(); }
});

test('Asset handler rejects another Job import before probe, processing or catalog writes', async () => {
  const f = await fixture();
  try {
    const i = await f.makeImport(true); const foreign = await f.makeJob('ASSET_IMPORT', { schemaVersion: 'ASSET_IMPORT_V0', projectId: f.project.id, importId: i.imported.id }, true);
    const result = await new JobRunner(f.jobs, 'wrong-import-owner').run(foreign.id, createAssetJobHandler({ db: f.db, jobs: f.jobs, imports: f.imports, assets: f.assets, storage: f.storage, ffprobePath: 'must-not-probe-this-import' }));
    assert.equal(result.state, 'FAILED'); assert.equal((result.error as { code: string }).code, 'ASSET_IMPORT_OWNER_JOB_MISMATCH'); assert.equal((await i.get())?.state, 'QUEUED');
    assert.equal((await f.db.query('select count(*)::int as count from assets')).rows[0].count, 0); assert.equal((await f.jobs.get(i.job.id))?.attemptCount, 0);
  } finally { await f.close(); }
});

test('Asset ordinary failure redacts both Job diagnostics and owner error fields before persistence', async () => {
  const f = await fixture();
  try {
    const i = await f.makeImport(true, true);
    f.assets.prepareStagedUpload = async () => { throw Object.assign(new Error('https://diagnostic-user:secret-diagnostic-password@fixture.invalid/asset?access_token=secret-diagnostic-token'), { code: 'ASSET_PREPARE_FIXTURE_FAILED', retryable: false }); };
    const result = await new JobRunner(f.jobs, 'redacted-asset-failure').run(i.job.id, createAssetJobHandler({ db: f.db, jobs: f.jobs, imports: f.imports, assets: f.assets, storage: f.storage, ffprobePath }));
    assert.equal(result.state, 'FAILED'); assert.equal((await i.get())?.state, 'FAILED');
    const raw = await f.db.query('select j.error as job_error,a.error as attempt_error,i.error_message from jobs j join job_attempts a on a.job_id=j.id join asset_imports i on i.job_id=j.id where j.id=$1', [i.job.id]);
    const serialized = JSON.stringify(raw.rows[0]); assert.doesNotMatch(serialized, /secret-diagnostic-(?:user|password|token)/u); assert.match(serialized, /REDACTED/u);
    await access(f.storage.stagedPath(i.imported.stagedPath));
  } finally { await f.close(); }
});

for (const projectOwned of [true, false]) {
  test(`Asset ${projectOwned ? 'project' : 'workspace'} third lease loss fails its owner and preserves input for explicit retry`, async () => {
    const f = await fixture();
    try {
      const i = await f.makeImport(projectOwned);
      for (let loss = 1; loss <= 3; loss += 1) {
        await f.lose(i.job, f.assetRecovery, i.start);
        assert.equal((await i.get())?.state, loss === 3 ? 'FAILED' : 'QUEUED');
        await access(f.storage.stagedPath(i.imported.stagedPath));
      }
      assert.equal((await f.jobs.get(i.job.id))?.state, 'FAILED');
      await f.jobs.requeueTerminal(i.job.id);
      const claim = await f.jobs.claim(i.job.id, 'manual-retry', 30_000); assert.ok(claim);
      assert.equal((await f.jobs.withCurrentAttemptFence(i.job.id, claim.attemptId, i.start)).executed, true);
      assert.equal((await i.get())?.state, 'PROCESSING');
    } finally { await f.close(); }
  });
}

test('Asset recovery owner mutation and lease counter roll back together on callback failure', async () => {
  const f = await fixture();
  try {
    const i = await f.makeImport(true); const claim = await f.jobs.claim(i.job.id, 'poisoned-recovery', 30_000); assert.ok(claim);
    await f.jobs.withCurrentAttemptFence(i.job.id, claim.attemptId, i.start);
    await f.db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [i.job.id]);
    assert.equal(await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['ASSET_IMPORT'], recover: async (job, scope, context) => { await f.assetRecovery(job, scope, context); throw new Error('rollback owner mutation'); } }), 0);
    assert.equal((await i.get())?.state, 'PROCESSING'); assert.equal((await f.jobs.get(i.job.id))?.state, 'RUNNING');
    assert.equal((await f.db.query('select consecutive_lease_failures from jobs where id=$1', [i.job.id])).rows[0].consecutive_lease_failures, 0);
    assert.equal(await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['ASSET_IMPORT'], recover: f.assetRecovery }), 1);
    assert.equal((await i.get())?.state, 'QUEUED');
  } finally { await f.close(); }
});

test('late Asset preparation preserves the retry input and cannot replace the newer successful import', { timeout: 20_000 }, async () => {
  const f = await fixture(); let release!: () => void; let entered!: () => void;
  const paused = new Promise<void>((resolvePause) => { release = resolvePause; }); const started = new Promise<void>((resolveStart) => { entered = resolveStart; });
  let oldRun: Promise<unknown> | undefined;
  try {
    const i = await f.makeImport(false, true);
    const nativePrepare = f.assets.prepareStagedUpload.bind(f.assets); let calls = 0;
    f.assets.prepareStagedUpload = async (input) => { const prepared = await nativePrepare(input); calls += 1; if (calls === 1) { entered(); await paused; } return prepared; };
    const handler = createAssetJobHandler({ db: f.db, jobs: f.jobs, imports: f.imports, assets: f.assets, storage: f.storage, ffprobePath });
    oldRun = new JobRunner(f.jobs, 'late-asset').run(i.job.id, handler); await started;
    await f.db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [i.job.id]);
    assert.equal(await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['ASSET_IMPORT'], recover: f.assetRecovery }), 1);
    await access(f.storage.stagedPath(i.imported.stagedPath));
    assert.equal((await new JobRunner(f.jobs, 'replacement-asset').run(i.job.id, handler)).state, 'SUCCEEDED');
    const completed = await i.get(); assert.equal(completed?.state, 'READY'); assert.ok(completed?.outputAssetId);
    release(); await oldRun;
    assert.equal((await i.get())?.outputAssetId, completed.outputAssetId); assert.equal((await f.jobs.get(i.job.id))?.state, 'SUCCEEDED');
    assert.equal((await f.db.query('select count(*)::int as count from video_workspace_assets where workspace_id=$1', [f.workspaceId])).rows[0].count, 1);
  } finally { release(); if (oldRun) await oldRun.catch(() => undefined); await f.close(); }
});

test('Video third lease loss atomically fails render, current plan/session, item and batch', async () => {
  const f = await fixture();
  try {
    const r = await f.makeRender(true); const batch = await f.makeBatch(r.job, false);
    for (let loss = 1; loss <= 3; loss += 1) await f.lose(r.job, f.videoRecovery, r.start);
    assert.equal((await f.jobs.get(r.job.id))?.state, 'FAILED');
    for (const [table, id, column] of [['renders', r.renderId, 'status'], ['edit_script_plans', r.planId, 'status'], ['script_editing_v3_sessions', r.sessionId, 'status'], ['edit_batch_items', batch.itemId, 'state'], ['edit_batches', batch.batchId, 'status']]) assert.equal((await f.db.query(`select ${column} from ${table} where id=$1`, [id])).rows[0][column!], 'FAILED');
    const counts = (await f.db.query('select failed_count,succeeded_count from edit_batches where id=$1', [batch.batchId])).rows[0]; assert.deepEqual(counts, { failed_count: 1, succeeded_count: 0 });
  } finally { await f.close(); }
});

test('Video recovery never overwrites an already successful render or another successful current manifest', async () => {
  const f = await fixture();
  try {
    const r = await f.makeRender(true);
    await f.db.query("insert into renders(id,workspace_id,manifest_id,status) values($1,$2,$3,'SUCCEEDED')", [`confirmed-${randomUUID()}`, f.workspaceId, r.manifestId]);
    await f.db.query("update edit_script_plans set status='RENDERED' where id=$1", [r.planId]);
    await f.db.query("update script_editing_v3_sessions set status='RENDERED' where id=$1", [r.sessionId]);
    for (let loss = 1; loss <= 3; loss += 1) await f.lose(r.job, f.videoRecovery, r.start);
    assert.equal((await f.db.query('select status from edit_script_plans where id=$1', [r.planId])).rows[0].status, 'RENDERED');
    assert.equal((await f.db.query('select status from script_editing_v3_sessions where id=$1', [r.sessionId])).rows[0].status, 'RENDERED');
    const completed = await f.makeRender(); await f.db.query("update renders set status='SUCCEEDED' where id=$1", [completed.renderId]);
    await f.lose(completed.job, f.videoRecovery); await f.assertBlockedStable(completed.job, f.videoRecovery);
    assert.equal((await f.db.query('select status from renders where id=$1', [completed.renderId])).rows[0].status, 'SUCCEEDED');
    assert.equal((await f.jobs.get(completed.job.id))?.state, 'BLOCKED');
  } finally { await f.close(); }
});

test('Video exhaustion also closes a queued render when its claimed attempt crashed before render start', async () => {
  const f = await fixture();
  try {
    const r = await f.makeRender();
    for (let loss = 1; loss <= 3; loss += 1) await f.lose(r.job, f.videoRecovery);
    assert.equal((await f.jobs.get(r.job.id))?.state, 'FAILED'); assert.equal((await f.db.query('select status from renders where id=$1', [r.renderId])).rows[0].status, 'FAILED');
  } finally { await f.close(); }
});

test('Video recovery refuses a render with a different current attempt instead of claiming owner failure', async () => {
  const f = await fixture();
  try {
    const r = await f.makeRender(); const differentJob = await f.makeJob('VIDEO_RENDER', { workspaceId: f.workspaceId }); const foreign = await f.jobs.claim(differentJob.id, 'other-render-attempt', 30_000); assert.ok(foreign);
    await f.db.query("update renders set status='RUNNING',attempt_id=$2,attempt_number=999 where id=$1", [r.renderId, foreign.attemptId]);
    await f.lose(r.job, f.videoRecovery); await f.assertBlockedStable(r.job, f.videoRecovery);
    assert.equal((await f.jobs.get(r.job.id))?.state, 'BLOCKED'); assert.equal((await f.db.query('select status,attempt_id from renders where id=$1', [r.renderId])).rows[0].attempt_id, foreign.attemptId);
  } finally { await f.close(); }
});

test('Video recovery distinguishes a valid target before render creation from a foreign manifest', async () => {
  const f = await fixture();
  try {
    const r = await f.makeRender(); await f.db.query('delete from renders where id=$1', [r.renderId]);
    for (let loss = 1; loss <= 3; loss += 1) await f.lose(r.job, f.videoRecovery);
    assert.equal((await f.jobs.get(r.job.id))?.state, 'FAILED');
    const differentWorkspace = `workspace-${randomUUID()}`; await ensureStandaloneWorkspace(f.db, differentWorkspace);
    const id = `job-${randomUUID()}`; const foreign = await f.jobs.create({ id, type: 'VIDEO_RENDER', projectId: null, workspaceId: differentWorkspace, payload: { workspaceId: differentWorkspace, manifestId: r.manifestId }, idempotencyKey: id, maxAttempts: 1 });
    await f.lose(foreign, f.videoRecovery); await f.assertBlockedStable(foreign, f.videoRecovery);
    assert.equal((await f.jobs.get(foreign.id))?.state, 'BLOCKED'); assert.equal((await f.db.query('select count(*)::int as count from renders')).rows[0].count, 0);
  } finally { await f.close(); }
});

test('visual analysis exhaustion only fails the matching pending fingerprint and provider configuration', async () => {
  const f = await fixture();
  try {
    for (const [index, state, fingerprint] of [[0, 'PENDING', '20::1000'], [1, 'READY', '20::1000'], [2, 'PENDING', 'newer-fingerprint'], [3, 'PENDING', '20::1000'], [4, 'PENDING', '20::1000']] as const) {
      const assetId = `visual-asset-${index}`;
      await f.db.query("insert into material_pool_items(snapshot_id,asset_id,canonical_path,source_path,file_name,duration_ms,file_size,source_kind,source_fingerprint) values($1,$2,$3,$3,'fixture.mp4',1000,20,'MANUAL','20::1000')", [f.snapshotId, assetId, join(f.root, `${index}.mp4`)]);
      await f.db.query(`insert into asset_visual_profiles(asset_id,summary,profile,provider,model_name,model_version,prompt_version,analysis_version,status,source_fingerprint)
        values($1,'fixture','{}','QWEN_VL','fixture-model','v1','prompt','analysis',$2,$3)`, [assetId, state, fingerprint]);
      const job = await f.makeJob('ANALYZE_ASSET_VISUAL', { snapshotId: f.snapshotId, assetId, analysisConfig: 'fixture-model:v1:prompt:analysis' });
      for (let loss = 1; loss <= (index === 0 ? 3 : 1); loss += 1) await f.lose(job, f.videoRecovery, index === 3 || state === 'READY' ? undefined : async (scope) => scope.query("update asset_visual_profiles set profile=jsonb_build_object('leaseAuthority',$2::jsonb) where asset_id=$1", [assetId, { jobId: index === 4 ? 'different-visual-job' : job.id, attemptId: scope.attemptId, attemptNumber: scope.attemptNumber }]));
      if (index !== 0) await f.assertBlockedStable(job, f.videoRecovery);
      assert.equal((await f.db.query('select status from asset_visual_profiles where asset_id=$1', [assetId])).rows[0].status, index === 0 ? 'FAILED' : state);
      assert.equal((await f.jobs.get(job.id))?.state, index === 0 ? 'FAILED' : 'BLOCKED');
    }
  } finally { await f.close(); }
});

test('exhausted prepare item cannot spawn replacement Jobs outside the lease budget', async () => {
  const f = await fixture();
  try {
    const job = await f.makeJob('EDIT_PREPARE_ITEM', {}); const batch = await f.makeBatch(job, true);
    await f.db.query('update jobs set payload=$2 where id=$1', [job.id, { itemId: batch.itemId, batchId: batch.batchId, workspaceId: f.workspaceId }]);
    for (let loss = 1; loss <= 3; loss += 1) await f.lose(job, f.videoRecovery);
    assert.equal((await f.db.query('select state from edit_batch_items where id=$1', [batch.itemId])).rows[0].state, 'FAILED');
    const before = (await f.db.query('select count(*)::int as count from jobs')).rows[0].count;
    const worker = createVideoWorker({ db: f.db, jobs: f.jobs, video: f.video, assets: f.assets, storage: f.storage, localMedia: f.localMedia, ffmpegPath, ffprobePath, pollIntervalMs: 10_000, reconcileIntervalMs: 10_000 });
    await worker.start(); await worker.shutdown('TEST_DONE');
    assert.equal((await f.db.query('select count(*)::int as count from jobs')).rows[0].count, before);
    assert.equal((await f.db.query('select status,failed_count from edit_batches where id=$1', [batch.batchId])).rows[0].status, 'FAILED');
  } finally { await f.close(); }
});

test('late Hybrid preparation cannot create a manifest/render Job or revive an exhausted batch item', { timeout: 20_000 }, async () => {
  const f = await fixture(); let release!: () => void; let entered!: () => void; let running: Promise<unknown> | undefined;
  const paused = new Promise<void>((resolvePause) => { release = resolvePause; }); const started = new Promise<void>((resolveStart) => { entered = resolveStart; });
  const originalResolve = HybridMediaService.prototype.resolve;
  try {
    const job = await f.makeJob('EDIT_PREPARE_ITEM', {}); const batch = await f.makeBatch(job, true);
    await f.db.query('update jobs set payload=$2 where id=$1', [job.id, { itemId: batch.itemId, batchId: batch.batchId, workspaceId: f.workspaceId }]);
    await f.db.query("update edit_batches set mode='SCRIPT' where id=$1", [batch.batchId]);
    await f.db.query("update edit_workbench_sessions set mode='SCRIPT',settings=$2 where id=(select session_id from edit_batches where id=$1)", [batch.batchId, { usePexels: true }]);
    HybridMediaService.prototype.resolve = async () => {
      entered(); await paused;
      const plan = { schemaVersion: 'VISUAL_PLAN_V1' as const, scriptHash: 'fixture', segments: [], generatedBy: 'deterministic-v1' as const };
      return { assets: [{ id: 'fixture-asset', storageKey: 'fixture', sourcePath: join(f.root, 'fixture.mp4'), durationMs: 60_000 }], plan, resolvedPlan: { schemaVersion: 'RESOLVED_VISUAL_PLAN_V1', plan, segments: [] }, resolvedAssignments: [], diagnostics: { localCount: 1, externalCount: 0, fallbackCount: 0, genericFallbackCount: 0, queries: [], warnings: [], sourceStats: { local: 1, pexels: 0, fallback: 0, genericFallback: 0 } } };
    };
    running = new JobRunner(f.jobs, 'late-prepare').run(job.id, createEditPrepareJobHandler({ db: f.db, jobs: f.jobs, video: f.video, assets: f.assets, storage: f.storage, localMedia: f.localMedia, ffmpegPath, ffprobePath }));
    await started; await f.db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [job.id]);
    assert.equal(await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['EDIT_PREPARE_ITEM'], recover: f.videoRecovery }), 1);
    await f.lose(job, f.videoRecovery); await f.lose(job, f.videoRecovery);
    assert.equal((await f.jobs.get(job.id))?.state, 'FAILED'); release(); await running;
    assert.equal((await f.db.query('select count(*)::int as count from jobs')).rows[0].count, 1);
    assert.equal((await f.db.query('select count(*)::int as count from edit_manifests')).rows[0].count, 0);
    assert.equal((await f.db.query('select state,job_id from edit_batch_items where id=$1', [batch.itemId])).rows[0].state, 'FAILED');
    assert.equal((await f.db.query('select status from edit_batches where id=$1', [batch.batchId])).rows[0].status, 'FAILED');
  } finally { release(); if (running) await running.catch(() => undefined); HybridMediaService.prototype.resolve = originalResolve; await f.close(); }
});

test('prepare provider failure redacts captured diagnostics before Job and item persistence', async () => {
  const f = await fixture(); const originalResolve = HybridMediaService.prototype.resolve;
  try {
    const job = await f.makeJob('EDIT_PREPARE_ITEM', {}); const batch = await f.makeBatch(job, true);
    await f.db.query('update jobs set payload=$2 where id=$1', [job.id, { itemId: batch.itemId, batchId: batch.batchId, workspaceId: f.workspaceId }]);
    await f.db.query("update edit_batches set mode='SCRIPT' where id=$1", [batch.batchId]);
    await f.db.query("update edit_workbench_sessions set mode='SCRIPT',settings=$2 where id=(select session_id from edit_batches where id=$1)", [batch.batchId, { usePexels: true }]);
    HybridMediaService.prototype.resolve = async () => { throw new Error('https://diagnostic-user:secret-diagnostic-password@fixture.invalid/prepare?access_token=secret-diagnostic-token'); };
    const result = await new JobRunner(f.jobs, 'redacted-prepare').run(job.id, createEditPrepareJobHandler({ db: f.db, jobs: f.jobs, video: f.video, assets: f.assets, storage: f.storage, localMedia: f.localMedia, ffmpegPath, ffprobePath }));
    assert.equal(result.state, 'FAILED');
    const raw = await f.db.query('select j.error as job_error,a.error as attempt_error,i.error as item_error from jobs j join job_attempts a on a.job_id=j.id join edit_batch_items i on i.prepare_job_id=j.id where j.id=$1', [job.id]);
    const serialized = JSON.stringify(raw.rows[0]); assert.doesNotMatch(serialized, /secret-diagnostic-(?:password|token)/u); assert.match(serialized, /REDACTED/u);
    assert.equal((await f.db.query('select state from edit_batch_items where id=$1', [batch.itemId])).rows[0].state, 'FAILED');
  } finally { HybridMediaService.prototype.resolve = originalResolve; await f.close(); }
});

for (const rejectSuccess of [false, true]) {
  test(`prepare publication ${rejectSuccess ? 'rolls manifest/child Job/item back when final Job success fails' : 'commits manifest/child Job/item and success in one attempt transaction'}`, async () => {
    const f = await fixture();
    try {
      const job = await f.makeJob('EDIT_PREPARE_ITEM', {}); const batch = await f.makeBatch(job, true);
      await f.db.query('update jobs set payload=$2 where id=$1', [job.id, { itemId: batch.itemId, batchId: batch.batchId, workspaceId: f.workspaceId }]);
      await f.db.query('update edit_workbench_sessions set settings=$2 where id=(select session_id from edit_batches where id=$1)', [batch.batchId, { scanAssets: [{ id: 'fixture-asset', storageKey: 'fixture', sourcePath: join(f.root, 'fixture.mp4'), durationMs: 60_000 }] }]);
      if (rejectSuccess) {
        await f.db.query(`create function reject_prepare_success() returns trigger language plpgsql as $body$ begin if new.id='${job.id}' and new.state='SUCCEEDED' then raise exception 'reject final Job success'; end if; return new; end $body$`);
        await f.db.query('create trigger reject_prepare_success before update on jobs for each row execute function reject_prepare_success()');
      }
      const result = await new JobRunner(f.jobs, 'atomic-prepare').run(job.id, createEditPrepareJobHandler({ db: f.db, jobs: f.jobs, video: f.video, assets: f.assets, storage: f.storage, localMedia: f.localMedia, ffmpegPath, ffprobePath }));
      assert.equal(result.state, rejectSuccess ? 'FAILED' : 'SUCCEEDED');
      assert.equal((await f.db.query('select count(*)::int as count from edit_manifests')).rows[0].count, rejectSuccess ? 0 : 1);
      assert.equal((await f.db.query('select count(*)::int as count from jobs')).rows[0].count, rejectSuccess ? 1 : 2);
      assert.equal((await f.db.query('select state from edit_batch_items where id=$1', [batch.itemId])).rows[0].state, rejectSuccess ? 'FAILED' : 'RENDERING');
    } finally { await f.close(); }
  });
}

test('Video recovery closes scan/export/planning/shot owners and explicitly handles output-only types', async () => {
  const f = await fixture();
  try {
    const planId = randomUUID(); const plan = await f.makeJob('EDIT_SCRIPT_PLAN', { planId });
    await f.db.query("insert into edit_script_plans(id,workspace_id,script,status,job_id) values($1,$2,'fixture','PLANNING',$3)", [planId, f.workspaceId, plan.id]);
    const scanId = `scan-${randomUUID()}`; const scan = await f.makeJob('LOCAL_MEDIA_SCAN', { scanId, sourceRoot: f.root });
    await f.db.query("insert into local_media_scans(id,workspace_id,source_root,source_root_id,recursive,status) values($1,$2,$3,'fixture-root',false,'RUNNING')", [scanId, f.workspaceId, f.root]);
    const runId = `shot-${randomUUID()}`; const shot = await f.makeJob('SHOT_DETECTION_V1', { runId, snapshotId: f.snapshotId, assetId: 'fixture-asset', sourceFingerprint: 'fingerprint' });
    await f.db.query("insert into script_editing_v3_shot_detection_runs(id,snapshot_id,asset_id,source_fingerprint,status) values($1,$2,'fixture-asset','fingerprint','RUNNING')", [runId, f.snapshotId]);
    const exporting = await f.makeJob('EDIT_EXPORT', {}); const batch = await f.makeBatch(exporting, false); const exportId = `export-${randomUUID()}`;
    await f.db.query('update jobs set payload=$2 where id=$1', [exporting.id, { exportId, batchItemId: batch.itemId }]);
    await f.db.query("insert into edit_exports(id,batch_item_id,asset_id,output_path,status,job_id) values($1,$2,'fixture-asset','fixture-path','RUNNING',$3)", [exportId, batch.itemId, exporting.id]);
    for (const job of [plan, scan, shot, exporting]) for (let loss = 1; loss <= 3; loss += 1) await f.lose(job, f.videoRecovery, job.id === shot.id ? async (scope) => scope.query("update script_editing_v3_shot_detection_runs set status='RUNNING',lease_authority=$2 where id=$1", [runId, { jobId: job.id, attemptId: scope.attemptId, attemptNumber: scope.attemptNumber }]) : undefined);
    for (const [table, id] of [['edit_script_plans', planId], ['local_media_scans', scanId], ['script_editing_v3_shot_detection_runs', runId], ['edit_exports', exportId]]) assert.equal((await f.db.query(`select status from ${table} where id=$1`, [id])).rows[0].status, 'FAILED');
    for (const type of ['GENERATE_REPRESENTATIVE_FRAMES', 'EDIT_V3_DRAFT_PREVIEW', 'IMPORT_JIANYING_DRAFT']) {
      const job = await f.makeJob(type, {}); for (let loss = 1; loss <= 3; loss += 1) await f.lose(job, f.videoRecovery);
      assert.equal((await f.jobs.get(job.id))?.state, 'FAILED');
    }
    const other = await f.makeImport(false); const claim = await f.jobs.claim(other.job.id, 'asset-worker', 30_000); assert.ok(claim);
    await f.db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [other.job.id]);
    assert.equal(await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: VIDEO_JOB_TYPES, recover: f.videoRecovery }), 0);
    assert.equal((await f.jobs.get(other.job.id))?.state, 'RUNNING');
  } finally { await f.close(); }
});

for (const authority of ['legacy', 'different-job'] as const) {
  test(`Shot recovery protects ${authority} authority instead of changing its shared run`, async () => {
    const f = await fixture();
    try {
      const runId = `shot-${randomUUID()}`;
      const payload = { runId, snapshotId: f.snapshotId, assetId: 'fixture-asset', sourceFingerprint: 'fingerprint' };
      const job = await f.makeJob('SHOT_DETECTION_V1', payload); const other = await f.makeJob('SHOT_DETECTION_V1', { ...payload, threshold: 0.7 });
      const otherAttempt = await f.jobs.claim(other.id, 'shared-shot-owner', 30_000); assert.ok(otherAttempt);
      const marker = authority === 'legacy' ? null : { jobId: other.id, attemptId: otherAttempt.attemptId, attemptNumber: otherAttempt.job.attemptCount };
      await f.db.query("insert into script_editing_v3_shot_detection_runs(id,snapshot_id,asset_id,source_fingerprint,status,lease_authority) values($1,$2,'fixture-asset','fingerprint','RUNNING',$3)", [runId, f.snapshotId, marker]);
      await f.lose(job, f.videoRecovery); await f.assertBlockedStable(job, f.videoRecovery);
      assert.equal((await f.jobs.get(job.id))?.state, 'BLOCKED');
      const run = (await f.db.query('select status,lease_authority from script_editing_v3_shot_detection_runs where id=$1', [runId])).rows[0];
      assert.equal(run.status, 'RUNNING'); assert.deepEqual(run.lease_authority, marker); assert.equal((await f.jobs.get(other.id))?.state, 'RUNNING');
    } finally { await f.close(); }
  });
}

test('project-owned scan recovery supports the canonical project workspace carried by its Job', async () => {
  const f = await fixture();
  try {
    const scanId = `project-scan-${randomUUID()}`; const job = await f.makeJob('LOCAL_MEDIA_SCAN', { scanId, sourceRoot: f.root }, true);
    await f.db.query('update jobs set workspace_id=$2 where id=$1', [job.id, `workspace-project-${f.project.id}`]);
    await f.db.query("insert into local_media_scans(id,project_id,source_root,source_root_id,recursive,status) values($1,$2,$3,'fixture-root',false,'RUNNING')", [scanId, f.project.id, f.root]);
    for (let loss = 1; loss <= 3; loss += 1) await f.lose(job, f.videoRecovery);
    assert.equal((await f.db.query('select status from local_media_scans where id=$1', [scanId])).rows[0].status, 'FAILED'); assert.equal((await f.jobs.get(job.id))?.state, 'FAILED');
  } finally { await f.close(); }
});

test('scan recovery blocks an actual filesystem alias when no durable canonical equivalence is recorded', async () => {
  const f = await fixture();
  try {
    const canonicalSource = join(f.root, 'canonical-source'); const alias = join(f.root, 'short-source'); await mkdir(canonicalSource); await symlink(canonicalSource, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const canonical = await realpath(canonicalSource); assert.equal(await realpath(alias), canonical); assert.notEqual(alias, canonical);
    const scanId = `alias-scan-${randomUUID()}`; const sourceRootId = `root-${randomUUID()}`;
    const job = await f.makeJob('LOCAL_MEDIA_SCAN', { scanId, sourceRoot: alias, sourceRootId });
    await f.db.query("insert into local_media_scans(id,workspace_id,source_root,source_root_id,recursive,status) values($1,$2,$3,$4,false,'RUNNING')", [scanId, f.workspaceId, canonical, sourceRootId]);
    await f.lose(job, f.videoRecovery); await f.assertBlockedStable(job, f.videoRecovery);
    assert.equal((await f.db.query('select status,source_root from local_media_scans where id=$1', [scanId])).rows[0].status, 'RUNNING');
    assert.equal((await f.db.query('select source_root from local_media_scans where id=$1', [scanId])).rows[0].source_root, canonical);
  } finally { await f.close(); }
});

test('scan recovery refuses unknown aliases, mismatched identities, successful output and foreign owners immediately', async () => {
  const f = await fixture();
  try {
    const otherWorkspace = `workspace-${randomUUID()}`; await ensureStandaloneWorkspace(f.db, otherWorkspace);
    const differentRoot = join(f.root, 'different-physical-source'); await mkdir(differentRoot);
    const oldRootId = (root: string) => `local-${Buffer.from(root.toLowerCase()).toString('base64url').slice(0, 18)}`;
    assert.equal(oldRootId(f.root), oldRootId(differentRoot));
    for (const kind of ['unproved-alias', 'wrong-root-id', 'colliding-root-id', 'succeeded', 'foreign-owner'] as const) {
      const scanId = `scan-${randomUUID()}`; const sourceRootId = kind === 'colliding-root-id' ? oldRootId(f.root) : `root-${randomUUID()}`;
      const state = kind === 'succeeded' ? 'SUCCEEDED' : 'RUNNING';
      await f.db.query('insert into local_media_scans(id,workspace_id,source_root,source_root_id,recursive,status) values($1,$2,$3,$4,false,$5)', [scanId, kind === 'foreign-owner' ? otherWorkspace : f.workspaceId, f.root, sourceRootId, state]);
      const job = await f.makeJob('LOCAL_MEDIA_SCAN', { scanId, sourceRoot: kind === 'unproved-alias' ? join(f.root, 'unproved-alias') : kind === 'colliding-root-id' ? differentRoot : f.root, ...(kind === 'unproved-alias' ? {} : { sourceRootId: kind === 'wrong-root-id' ? 'wrong-root-identity' : sourceRootId }) });
      await f.lose(job, f.videoRecovery); await f.assertBlockedStable(job, f.videoRecovery);
      const after = (await f.db.query('select status,source_root,source_root_id from local_media_scans where id=$1', [scanId])).rows[0];
      assert.equal(after.status, state); assert.equal(after.source_root, f.root); assert.equal(after.source_root_id, sourceRootId);
    }
  } finally { await f.close(); }
});
