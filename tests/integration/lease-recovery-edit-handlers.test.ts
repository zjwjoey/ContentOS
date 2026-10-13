import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { AssetCatalogService, AssetService, LocalMediaSourceService, type LocalMediaScanResult } from '../../packages/modules/asset/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { generateFixtureVideo, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { JobRunner, JobService, type JobRecord } from '../../packages/modules/job/src/index.js';
import { ensureStandaloneWorkspace, planEditorialScript, VideoService } from '../../packages/modules/video/src/index.js';
import { createEditExportJobHandler, createLocalMediaScanJobHandler, createScriptPlanJobHandler, createShotDetectionJobHandler, type VideoHandlerDeps } from '../../workers/video-worker/src/video-handler.js';
import { createVideoLeaseRecoveryHandler, VIDEO_JOB_TYPES } from '../../workers/video-worker/src/lease-recovery.js';

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';

function gate() { let release!: () => void; let enter!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; }); const entered = new Promise<void>((resolve) => { enter = resolve; }); return { release, entered, hold: async () => { enter(); await waiting; } }; }

async function fixture() {
  const url = process.env.CONTENTOS_TEST_DATABASE_URL; assert.ok(url, 'explicit isolated test database required'); assert.equal(new URL(url).pathname, '/contentos_test');
  const admin = await createDatabase(url); const schema = `contentos_edit_fence_${randomUUID().replaceAll('-', '')}`; await admin.query(`create schema "${schema}"`);
  const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`); const db = new pg.Pool({ connectionString: scoped.toString(), max: 4, connectionTimeoutMillis: 2_000 }); await migrateUp(db);
  const root = await mkdtemp(join(tmpdir(), 'contentos-edit-fence-')); const workspaceId = `workspace-${randomUUID()}`; await ensureStandaloneWorkspace(db, workspaceId);
  const storage = new LocalStorageProvider(root); const jobs = new JobService(db); const assets = new AssetService(db, storage, (path) => probeMedia(path, ffprobePath)); const video = new VideoService(db, storage, jobs, new AssetCatalogService(db)); const localMedia = new LocalMediaSourceService({ db, allowedRoots: [root], thumbnailRoot: join(root, 'thumbnails') });
  const deps: VideoHandlerDeps = { db, jobs, assets, video, storage, localMedia, ffmpegPath, ffprobePath };
  const emptyScan: LocalMediaScanResult = { sourceRootId: 'fixture-root', files: [], totalCount: 0, availableCount: 0, unavailableCount: 0 };
  const recover = () => jobs.reconcileExpiredLeases(new Date(), undefined, { types: VIDEO_JOB_TYPES, recover: createVideoLeaseRecoveryHandler(deps) });
  const makeJob = (type: string, payload: unknown) => { const id = `job-${randomUUID()}`; return jobs.create({ id, projectId: null, workspaceId, type, payload, idempotencyKey: id, maxAttempts: 1 }); };
  const exhaust = async (job: JobRecord) => { for (let index = 1; index <= 3; index += 1) { if (index > 1) { await jobs.requeue(job.id); const claimed = await jobs.claim(job.id, `replacement-${index}`, 60_000); assert.ok(claimed); if (job.type === 'SHOT_DETECTION_V1') await jobs.withCurrentAttemptFence(job.id, claimed.attemptId, (scope) => scope.query("update script_editing_v3_shot_detection_runs set status='RUNNING',lease_authority=$2 where id=$1", [(job.payload as { runId: string }).runId, { jobId: job.id, attemptId: scope.attemptId, attemptNumber: scope.attemptNumber }])); } await db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [job.id]); assert.equal(await recover(), 1); } assert.equal((await jobs.get(job.id))?.state, 'FAILED'); };
  const makeScan = async () => { const id = `scan-${randomUUID()}`; const registration = await localMedia.prepareScanRegistration({ id, workspaceId, sourceRoot: root, recursive: false }); await localMedia.createPreparedScan(registration); const job = await makeJob('LOCAL_MEDIA_SCAN', { scanId: id, sourceRoot: registration.sourceRoot, sourceRootId: registration.sourceRootId, recursive: false }); return { id, job }; };
  const makePlan = async (scan = false) => { const id = randomUUID(); const job = await makeJob('EDIT_SCRIPT_PLAN', { planId: id }); const editorial = scan ? planEditorialScript({ sentences: [{ index: 0, text: '确定性测试。', normalizedText: '确定性测试', durationMs: 1_000 }], audioPlan: { backgroundMusicMode: 'NONE' } }) : null; await db.query("insert into edit_script_plans(id,workspace_id,script,status,job_id,settings,source_roots,editorial_plan,resolved_plan) values($1,$2,'确定性测试。','QUEUED',$3,$4,$5,$6,$7)", [id, workspaceId, job.id, { seed: 1, usePexels: false, assets: [] }, JSON.stringify(scan ? [root] : []), editorial, scan ? null : { audioPlan: { backgroundMusicMode: 'NONE' } }]); return { id, job }; };
  const makeExport = async () => { const id = `export-${randomUUID()}`; const itemId = `item-${randomUUID()}`; const batchId = `batch-${randomUUID()}`; const sessionId = `session-${randomUUID()}`; const assetId = `asset-${randomUUID()}`; const source = join(root, 'export-source.bin'); const output = join(root, 'export-output.mp4'); await writeFile(source, 'copy fixture bytes'); await db.query("insert into assets(id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values($1,'VIDEO_RENDER','fixture',18,'export-source.bin','READY','{}')", [assetId]); await db.query("insert into video_workspace_assets(workspace_id,asset_id,role) values($1,$2,'OUTPUT')", [workspaceId, assetId]); await db.query("insert into edit_workbench_sessions(id,mode,title) values($1,'MIX','fixture')", [sessionId]); await db.query("insert into edit_batches(id,session_id,mode,status,total_count) values($1,$2,'MIX','SUCCEEDED',1)", [batchId, sessionId]); await db.query("insert into edit_batch_items(id,batch_id,ordinal,title,script,workspace_id,state) values($1,$2,1,'fixture','fixture',$3,'SUCCEEDED')", [itemId, batchId, workspaceId]); const job = await makeJob('EDIT_EXPORT', { exportId: id, batchItemId: itemId, workspaceId, assetId, outputPath: output, outputRoot: root }); await db.query("insert into edit_exports(id,batch_item_id,asset_id,output_path,status,job_id) values($1,$2,$3,$4,'QUEUED',$5)", [id, itemId, assetId, output, job.id]); return { id, job, itemId, source, output }; };
  const makeShot = async () => { const id = `shot-run-${randomUUID()}`; const snapshotId = `snapshot-${randomUUID()}`; const source = join(root, 'shots.mp4'); await generateFixtureVideo(source, ffmpegPath, 'blue', 1); await db.query('insert into material_pool_snapshots(id,workspace_id,revision) values($1,$2,1)', [snapshotId, workspaceId]); const job = await makeJob('SHOT_DETECTION_V1', { runId: id, snapshotId, assetId: 'fixture-shot-asset', sourceFingerprint: 'fixture-fingerprint', sourcePath: source, durationMs: 1_000 }); await db.query("insert into script_editing_v3_shot_detection_runs(id,snapshot_id,asset_id,source_fingerprint,status) values($1,$2,'fixture-shot-asset','fixture-fingerprint','QUEUED')", [id, snapshotId]); return { id, job, snapshotId }; };
  return { db, jobs, deps, localMedia, root, workspaceId, scopedUrl: scoped.toString(), emptyScan, exhaust, makeScan, makePlan, makeExport, makeShot, close: async () => { await db.end(); assert.match(schema, /^contentos_edit_fence_[a-f0-9]{32}$/u); await admin.query(`drop schema "${schema}" cascade`); await admin.end(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('contentos-edit-fence-')); await rm(root, { recursive: true, force: true }); } };
}

for (const type of ['LOCAL_MEDIA_SCAN', 'EDIT_SCRIPT_PLAN'] as const) {
  for (const outcome of ['return', 'throw'] as const) {
    test(`${type} late scanner ${outcome} cannot resurrect its exhausted owner or create replacement work`, { timeout: 20_000 }, async () => {
      const f = await fixture(); const hold = gate(); const item = type === 'LOCAL_MEDIA_SCAN' ? await f.makeScan() : await f.makePlan(true);
      f.localMedia.scan = async () => { await hold.hold(); if (outcome === 'throw') throw new Error('late scan failure'); return f.emptyScan; };
      const handler = type === 'LOCAL_MEDIA_SCAN' ? createLocalMediaScanJobHandler(f.deps) : createScriptPlanJobHandler(f.deps);
      const running = new JobRunner(f.jobs, 'obsolete-scanner', 60_000).run(item.job.id, handler);
      try {
        await hold.entered; await f.exhaust(item.job); const table = type === 'LOCAL_MEDIA_SCAN' ? 'local_media_scans' : 'edit_script_plans';
        const before = (await f.db.query(`select * from ${table} where id=$1`, [item.id])).rows[0]; const jobCount = (await f.db.query('select count(*)::int as count from jobs')).rows[0].count; const scanCount = (await f.db.query('select count(*)::int as count from local_media_scans')).rows[0].count;
        hold.release(); assert.equal((await running).state, 'FAILED'); assert.deepEqual((await f.db.query(`select * from ${table} where id=$1`, [item.id])).rows[0], before);
        assert.equal((await f.db.query('select count(*)::int as count from jobs')).rows[0].count, jobCount); assert.equal((await f.db.query('select count(*)::int as count from local_media_scans')).rows[0].count, scanCount);
      } finally { hold.release(); await running; await f.close(); }
    });
  }
}

for (const anotherLock of [false, true]) {
  test(`obsolete export cannot complete after exhaustion${anotherLock ? ' or remove another attempt lock' : ''}`, { timeout: 20_000 }, async () => {
    const f = await fixture(); const item = await f.makeExport(); const hold = gate();
    const deps: VideoHandlerDeps = { ...f.deps, localPathAccess: { authorize: async () => { await hold.hold(); return f.root; } } as never };
    const running = new JobRunner(f.jobs, 'obsolete-export', 60_000).run(item.job.id, createEditExportJobHandler(deps));
    try {
      await hold.entered; await f.exhaust(item.job); const before = (await f.db.query('select * from edit_exports where id=$1', [item.id])).rows[0];
      if (anotherLock) { await mkdir(`${item.output}.lock`); await writeFile(join(`${item.output}.lock`, 'new-attempt-marker'), 'keep'); }
      hold.release(); assert.equal((await running).state, 'FAILED'); assert.deepEqual((await f.db.query('select * from edit_exports where id=$1', [item.id])).rows[0], before);
      assert.equal(await access(item.output).then(() => true).catch(() => false), false); if (anotherLock) assert.equal(await readFile(join(`${item.output}.lock`, 'new-attempt-marker'), 'utf8'), 'keep');
    } finally { hold.release(); await running; await f.close(); }
  });
}

test('old shot completion cannot delete a successful explicit replacement attempt dataset', { timeout: 20_000 }, async () => {
  const f = await fixture(); const item = await f.makeShot(); const hold = gate(); const observer = new pg.Pool({ connectionString: f.scopedUrl, max: 1 }); const connect = f.db.connect.bind(f.db); let held = false;
  f.db.connect = ((callback?: (error: Error | null, client?: pg.PoolClient, release?: () => void) => void) => {
    const connection = (async () => { if (!held && (await observer.query('select status from script_editing_v3_shot_detection_runs where id=$1', [item.id])).rows[0]?.status === 'RUNNING') { held = true; await hold.hold(); } return connect(); })();
    if (callback) { void connection.then((client) => callback(null, client, client.release.bind(client)), (error: Error) => callback(error)); return; }
    return connection;
  }) as typeof f.db.connect;
  const running = new JobRunner(f.jobs, 'obsolete-shots', 60_000).run(item.job.id, createShotDetectionJobHandler(f.deps));
  try {
    await hold.entered; await f.exhaust(item.job); assert.equal((await observer.query('select status from script_editing_v3_shot_detection_runs where id=$1', [item.id])).rows[0].status, 'FAILED');
    await f.jobs.requeueTerminal(item.job.id); assert.equal((await new JobRunner(f.jobs, 'explicit-replacement').run(item.job.id, createShotDetectionJobHandler(f.deps))).state, 'SUCCEEDED');
    const before = await f.db.query('select * from script_editing_v3_shots where run_id=$1 order by shot_index', [item.id]); const segments = await f.db.query('select * from source_segments where snapshot_id=$1 order by id', [item.snapshotId]); assert.ok(before.rows.length > 0);
    hold.release(); assert.equal((await running).state, 'SUCCEEDED'); assert.deepEqual((await f.db.query('select * from script_editing_v3_shots where run_id=$1 order by shot_index', [item.id])).rows, before.rows); assert.deepEqual((await f.db.query('select * from source_segments where snapshot_id=$1 order by id', [item.snapshotId])).rows, segments.rows);
  } finally { hold.release(); await running; f.db.connect = connect; await observer.end(); await f.close(); }
});

test('a different-threshold Job cannot steal a shared RUNNING Shot owner and later reuses frozen success', { timeout: 20_000 }, async () => {
  const f = await fixture(); const item = await f.makeShot(); const hold = gate(); const commit = f.jobs.succeedWithCurrentAttempt.bind(f.jobs); let delayed = false;
  f.jobs.succeedWithCurrentAttempt = (async (id, attemptId, action) => { if (id === item.job.id && !delayed) { delayed = true; await hold.hold(); } return commit(id, attemptId, action); }) as typeof f.jobs.succeedWithCurrentAttempt;
  const running = new JobRunner(f.jobs, 'threshold-a', 60_000).run(item.job.id, createShotDetectionJobHandler(f.deps));
  try {
    await hold.entered; const before = (await f.db.query('select * from script_editing_v3_shot_detection_runs where id=$1', [item.id])).rows[0];
    const other = await f.jobs.create({ id: `job-${randomUUID()}`, projectId: null, workspaceId: f.workspaceId, type: 'SHOT_DETECTION_V1', payload: { ...item.job.payload as Record<string, unknown>, threshold: 0.9 }, idempotencyKey: randomUUID(), maxAttempts: 1 });
    const rejected = await new JobRunner(f.jobs, 'threshold-b').run(other.id, createShotDetectionJobHandler(f.deps));
    assert.equal(rejected.state, 'FAILED'); assert.equal((rejected.error as { code: string }).code, 'SHOT_DETECTION_OWNER_BUSY'); assert.deepEqual((await f.db.query('select * from script_editing_v3_shot_detection_runs where id=$1', [item.id])).rows[0], before);
    hold.release(); assert.equal((await running).state, 'SUCCEEDED');
    const success = (await f.db.query('select * from script_editing_v3_shot_detection_runs where id=$1', [item.id])).rows[0]; const shots = (await f.db.query('select * from script_editing_v3_shots where run_id=$1 order by shot_index', [item.id])).rows;
    await f.jobs.requeueTerminal(other.id); const cached = await new JobRunner(f.jobs, 'threshold-b-explicit').run(other.id, createShotDetectionJobHandler(f.deps)); assert.equal(cached.state, 'SUCCEEDED'); assert.equal((cached.result as { cached: boolean }).cached, true);
    assert.deepEqual((await f.db.query('select * from script_editing_v3_shot_detection_runs where id=$1', [item.id])).rows[0], success); assert.deepEqual((await f.db.query('select * from script_editing_v3_shots where run_id=$1 order by shot_index', [item.id])).rows, shots);
  } finally { hold.release(); await running; f.jobs.succeedWithCurrentAttempt = commit; await f.close(); }
});

test('expired Shot Job cannot recover or overwrite a different Job that acquired the shared run', { timeout: 20_000 }, async () => {
  const f = await fixture(); const item = await f.makeShot(); const oldHold = gate(); const newHold = gate(); const commit = f.jobs.succeedWithCurrentAttempt.bind(f.jobs); let otherId = ''; let firstHeld = false; let secondHeld = false;
  f.jobs.succeedWithCurrentAttempt = (async (id, attemptId, action) => { if (id === item.job.id && !firstHeld) { firstHeld = true; await oldHold.hold(); } if (id === otherId && !secondHeld) { secondHeld = true; await newHold.hold(); } return commit(id, attemptId, action); }) as typeof f.jobs.succeedWithCurrentAttempt;
  const running = new JobRunner(f.jobs, 'old-threshold', 60_000).run(item.job.id, createShotDetectionJobHandler(f.deps)); let replacement: Promise<JobRecord> | undefined;
  try {
    await oldHold.entered; await f.db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [item.job.id]); const recovery = createVideoLeaseRecoveryHandler(f.deps); assert.equal(await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['SHOT_DETECTION_V1'], recover: recovery }), 1);
    const other = await f.jobs.create({ id: `job-${randomUUID()}`, projectId: null, workspaceId: f.workspaceId, type: 'SHOT_DETECTION_V1', payload: { ...item.job.payload as Record<string, unknown>, threshold: 0.9 }, idempotencyKey: randomUUID(), maxAttempts: 1 }); otherId = other.id;
    replacement = new JobRunner(f.jobs, 'new-threshold', 60_000).run(other.id, createShotDetectionJobHandler(f.deps)); await newHold.entered;
    const before = (await f.db.query('select * from script_editing_v3_shot_detection_runs where id=$1', [item.id])).rows[0]; assert.equal(before.lease_authority.jobId, other.id);
    await f.jobs.requeue(item.job.id); assert.ok(await f.jobs.claim(item.job.id, 'old-recovery-2', 60_000)); await f.db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [item.job.id]); assert.equal(await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['SHOT_DETECTION_V1'], recover: recovery }), 1); assert.deepEqual((await f.db.query('select * from script_editing_v3_shot_detection_runs where id=$1', [item.id])).rows[0], before);
    assert.equal((await f.jobs.get(item.job.id))?.state, 'BLOCKED');
    newHold.release(); assert.equal((await replacement).state, 'SUCCEEDED'); const shots = (await f.db.query('select * from script_editing_v3_shots where run_id=$1 order by shot_index', [item.id])).rows;
    oldHold.release(); assert.equal((await running).state, 'BLOCKED'); assert.deepEqual((await f.db.query('select * from script_editing_v3_shots where run_id=$1 order by shot_index', [item.id])).rows, shots); assert.equal((await f.jobs.get(other.id))?.state, 'SUCCEEDED');
  } finally { oldHold.release(); newHold.release(); await running; if (replacement) await replacement; f.jobs.succeedWithCurrentAttempt = commit; await f.close(); }
});

for (const type of ['LOCAL_MEDIA_SCAN', 'EDIT_SCRIPT_PLAN', 'EDIT_EXPORT', 'SHOT_DETECTION_V1'] as const) {
  test(`${type} owner and Job complete through one atomic current attempt transaction`, async () => {
    const f = await fixture();
    try {
      f.localMedia.scan = async () => f.emptyScan;
      const item = type === 'LOCAL_MEDIA_SCAN' ? await f.makeScan() : type === 'EDIT_SCRIPT_PLAN' ? await f.makePlan() : type === 'EDIT_EXPORT' ? await f.makeExport() : await f.makeShot();
      const handlers = { LOCAL_MEDIA_SCAN: createLocalMediaScanJobHandler, EDIT_SCRIPT_PLAN: createScriptPlanJobHandler, EDIT_EXPORT: createEditExportJobHandler, SHOT_DETECTION_V1: createShotDetectionJobHandler };
      const deps = type === 'EDIT_EXPORT' ? { ...f.deps, localPathAccess: { authorize: async () => f.root } as never } : f.deps;
      assert.equal((await new JobRunner(f.jobs, 'normal-success').run(item.job.id, handlers[type](deps))).state, 'SUCCEEDED');
      const table = type === 'LOCAL_MEDIA_SCAN' ? 'local_media_scans' : type === 'EDIT_SCRIPT_PLAN' ? 'edit_script_plans' : type === 'EDIT_EXPORT' ? 'edit_exports' : 'script_editing_v3_shot_detection_runs';
      assert.equal((await f.db.query(`select status from ${table} where id=$1`, [item.id])).rows[0].status, type === 'EDIT_SCRIPT_PLAN' ? 'READY' : 'SUCCEEDED');
      assert.equal((await f.db.query("select id from job_events where job_id=$1 and event_type='job.succeeded'", [item.job.id])).rows.length, 1);
    } finally { await f.close(); }
  });
}

test('scan index and owner success roll back together when Job final commit is rejected', async () => {
  const f = await fixture();
  try {
    const item = await f.makeScan(); const sourcePath = join(f.root, 'fixture.bin'); await writeFile(sourcePath, 'fingerprint fixture');
    f.localMedia.scan = async () => ({ ...f.emptyScan, totalCount: 1, availableCount: 1, files: [{ fileName: 'fixture.bin', relativePath: 'fixture.bin', sourcePath, durationMs: 1_000, width: 640, height: 360, format: 'mp4', orientation: 'HORIZONTAL', tags: [], available: true }] });
    await f.db.query("create function reject_scan_success() returns trigger language plpgsql as $$ begin if new.state='SUCCEEDED' then raise exception 'fixture rejects final commit'; end if; return new; end $$"); await f.db.query('create trigger reject_scan_success before update on jobs for each row execute function reject_scan_success()');
    assert.equal((await new JobRunner(f.jobs, 'atomic-scan-veto').run(item.job.id, createLocalMediaScanJobHandler(f.deps))).state, 'FAILED');
    assert.equal((await f.db.query('select status from local_media_scans where id=$1', [item.id])).rows[0].status, 'FAILED'); assert.equal((await f.db.query('select * from local_media_scan_files where scan_id=$1', [item.id])).rows.length, 0); assert.equal((await f.db.query('select * from local_media_index')).rows.length, 0);
  } finally { await f.close(); }
});

test('scan accepts an older queued path alias only after preparing its canonical owner root outside the fence', async () => {
  const f = await fixture();
  try {
    const item = await f.makeScan(); const row = (await f.db.query('select source_root,source_root_id from local_media_scans where id=$1', [item.id])).rows[0]; const alias = `${f.root}${sep}..${sep}${basename(f.root)}`;
    await f.db.query('update jobs set payload=$2 where id=$1', [item.job.id, { ...item.job.payload as Record<string, unknown>, sourceRoot: alias }]);
    let inFence = false; const fence = f.jobs.withCurrentAttemptFence.bind(f.jobs); const prepare = f.localMedia.prepareScanOwnerRoot.bind(f.localMedia);
    f.jobs.withCurrentAttemptFence = (async (id, attemptId, action) => fence(id, attemptId, async (scope) => { inFence = true; try { return await action(scope); } finally { inFence = false; } })) as typeof f.jobs.withCurrentAttemptFence;
    f.localMedia.prepareScanOwnerRoot = (input) => { assert.equal(inFence, false); return prepare(input); };
    f.localMedia.scan = async (input) => { assert.equal(input.sourceRoot, row.source_root); assert.equal(input.sourceRootId, row.source_root_id); return { ...f.emptyScan, sourceRootId: row.source_root_id }; };
    assert.equal((await new JobRunner(f.jobs, 'canonical-alias').run(item.job.id, createLocalMediaScanJobHandler(f.deps))).state, 'SUCCEEDED');
    assert.equal((await f.db.query('select status from local_media_scans where id=$1', [item.id])).rows[0].status, 'SUCCEEDED');
  } finally { await f.close(); }
});

test('normal scan failure redacts provider credentials before both owner and Job persistence', async () => {
  const f = await fixture();
  try {
    const item = await f.makeScan();
    f.localMedia.scan = async () => { throw Object.assign(new Error('Probe https://fixture-user:synthetic-password@provider.test/analyze?api_key=synthetic-key&token=synthetic-token Authorization: Bearer synthetic-bearer'), { code: 'UPSTREAM_SCAN_REJECTED', retryable: false }); };
    const result = await new JobRunner(f.jobs, 'scan-redaction').run(item.job.id, createLocalMediaScanJobHandler(f.deps));
    const owner = (await f.db.query('select status,error from local_media_scans where id=$1', [item.id])).rows[0];
    assert.equal(result.state, 'FAILED'); assert.equal(owner.status, 'FAILED'); assert.equal(owner.error.code, 'UPSTREAM_SCAN_REJECTED'); assert.deepEqual(result.error, owner.error);
    for (const secret of ['synthetic-password', 'synthetic-key', 'synthetic-token', 'synthetic-bearer']) assert.equal(JSON.stringify(owner.error).includes(secret), false);
    assert.match(owner.error.message, /REDACTED/u);
  } finally { await f.close(); }
});
