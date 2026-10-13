import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import pg from 'pg';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { JobRunner, JobService } from '../../packages/modules/job/src/index.js';
import { ensureStandaloneWorkspace, ScriptEditingV3Service, VideoService } from '../../packages/modules/video/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { createVisualAnalysisJobHandler } from '../../workers/video-worker/src/video-handler.js';
import { createVideoLeaseRecoveryHandler } from '../../workers/video-worker/src/lease-recovery.js';
import { generateFixtureVideo } from '../../packages/infrastructure/ffmpeg/src/index.js';

async function fixture() {
  const url = process.env.CONTENTOS_TEST_DATABASE_URL; assert.ok(url, 'explicit isolated database required'); assert.equal(new URL(url).pathname, '/contentos_test');
  const admin = await createDatabase(url); const schema = `visual_lease_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`); const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
  const db = new pg.Pool({ connectionString: scoped.toString(), max: 2, connectionTimeoutMillis: 2_000 }); await migrateUp(db);
  const root = await mkdtemp(join(tmpdir(), 'contentos-visual-lease-')); const workspaceId = `workspace-${randomUUID()}`;
  await ensureStandaloneWorkspace(db, workspaceId); const snapshotId = `snapshot-${randomUUID()}`; const assetId = `asset-${randomUUID()}`;
  await db.query('insert into material_pool_snapshots(id,workspace_id,revision) values($1,$2,1)', [snapshotId, workspaceId]);
  const sourcePath = join(root, 'fixture.mp4'); await writeFile(sourcePath, 'fixture');
  await db.query("insert into material_pool_items(snapshot_id,asset_id,canonical_path,source_path,file_name,duration_ms,file_size,source_kind,source_fingerprint) values($1,$2,$3,$3,'fixture.mp4',1000,7,'MANUAL','7::1000')", [snapshotId, assetId, sourcePath]);
  const frames = join(root, 'representative-frames', 'cached'); await mkdir(frames, { recursive: true });
  for (let index = 0; index < 5; index += 1) { await writeFile(join(frames, `${index}.jpg`), `fake-frame-${index}`); await db.query("insert into asset_representative_frames(asset_id,source_fingerprint,frame_generation_version,frame_index,timestamp_ms,frame_key) values($1,'7::1000','representative-frames-v1',$2,$3,$4)", [assetId, index, index * 200, `cached/${index}.jpg`]); }
  const jobs = new JobService(db); const storage = new LocalStorageProvider(root); const video = new VideoService(db, storage, jobs); const v3 = new ScriptEditingV3Service(db);
  const make = async (type = 'ANALYZE_ASSET_VISUAL') => { const id = `job-${randomUUID()}`; return jobs.create({ id, type, projectId: null, workspaceId, idempotencyKey: id, maxAttempts: 3, payload: { snapshotId, assetId, analysisConfig: 'lease-visual:1:qwen-visual-v2:asset-profile-v2' } }); };
  const recover = createVideoLeaseRecoveryHandler({ video });
  const expire = async (id: string) => { await db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [id]); await jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['ANALYZE_ASSET_VISUAL', 'GENERATE_REPRESENTATIVE_FRAMES'], recover }); };
  return { db, jobs, storage, video, v3, root, sourcePath, workspaceId, snapshotId, assetId, make, recover, expire, handler: createVisualAnalysisJobHandler({ db, jobs, video, storage, assets: {} as never, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', ffprobePath: process.env.FFPROBE_PATH || 'ffprobe' }), close: async () => { await db.end(); await admin.query(`drop schema "${schema}" cascade`); await admin.end(); await rm(root, { recursive: true, force: true }); } };
}

async function localProvider(context: TestContext, profile: () => Promise<string>, embedding?: () => Promise<number[]>) {
  const server = createServer((request, response) => { void (async () => {
    for await (const _chunk of request) { /* consume only synthetic frame input */ }
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/embeddings')) response.end(JSON.stringify({ data: [{ embedding: embedding ? await embedding() : [1, 0] }] }));
    else response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: await profile(), tags: [], recommendedFrameIndexes: [0] }) } }] }));
  })().catch(() => { response.statusCode = 500; response.end('{}'); }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const keys = ['QWEN_BASE_URL', 'QWEN_API_KEY', 'QWEN_VL_MODEL', 'QWEN_MODEL_VERSION'] as const; const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.QWEN_BASE_URL = `http://127.0.0.1:${address.port}/v1`; process.env.QWEN_API_KEY = 'synthetic-test-key'; process.env.QWEN_VL_MODEL = 'lease-visual'; process.env.QWEN_MODEL_VERSION = '1';
  const nativeFetch = globalThis.fetch;
  context.mock.method(globalThis, 'fetch', (url: string | URL | Request, options?: RequestInit) => { const { signal: _ignoredSignal, ...requestOptions } = options || {}; return nativeFetch(url, requestOptions); });
  return async () => { context.mock.restoreAll(); for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); };
}

for (const outcome of ['return', 'throw'] as const) {
  test(`late visual provider ${outcome} cannot replace the current successful profile`, async (context) => {
    const f = await fixture(); let release!: () => void; let entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; }); let calls = 0;
    const closeProvider = await localProvider(context, async () => { if (++calls === 1) { entered(); await gate; if (outcome === 'throw') throw new Error('late provider failure'); return 'stale profile'; } return 'replacement profile'; });
    let old: Promise<unknown> | undefined;
    try {
      const job = await f.make(); old = new JobRunner(f.jobs, 'slow-visual').run(job.id, f.handler); await started; await f.expire(job.id);
      const replaced = await new JobRunner(f.jobs, 'replacement-visual').run(job.id, f.handler); assert.equal(replaced.state, 'SUCCEEDED');
      const before = (await f.db.query('select * from asset_visual_profiles where asset_id=$1', [f.assetId])).rows[0]; assert.equal(before.summary, 'replacement profile'); assert.equal(before.profile.leaseAuthority, undefined);
      release(); await old; assert.deepEqual((await f.db.query('select * from asset_visual_profiles where asset_id=$1', [f.assetId])).rows[0], before);
    } finally { release(); if (old) await old; await closeProvider(); await f.close(); }
  });
}

test('foreign visual cache authority blocks an old Job instead of failing another live profile', async () => {
  const f = await fixture();
  try {
    const first = await f.make(); const second = await f.make(); const current = await f.jobs.claim(second.id, 'new-owner', 30_000); assert.ok(current);
    await f.jobs.withCurrentAttemptFence(second.id, current.attemptId, (scope) => f.v3.beginVisualAttempt(scope, current.job, f.assetId, '7::1000', 'lease-visual', '1'));
    const before = (await f.db.query('select * from asset_visual_profiles where asset_id=$1', [f.assetId])).rows[0];
    await f.jobs.claim(first.id, 'old-owner', 30_000); await f.expire(first.id);
    assert.equal((await f.jobs.get(first.id))?.state, 'BLOCKED'); assert.equal((await f.jobs.get(second.id))?.state, 'RUNNING');
    assert.equal((await f.jobs.get(first.id))?.attemptCount, 1);
    assert.equal(await f.jobs.claim(first.id, 'unsafe-replay', 30_000), null);
    await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['ANALYZE_ASSET_VISUAL'], recover: f.recover });
    assert.equal((await f.jobs.get(first.id))?.attemptCount, 1);
    assert.deepEqual((await f.db.query('select * from asset_visual_profiles where asset_id=$1', [f.assetId])).rows[0], before);
  } finally { await f.close(); }
});

for (const outcome of ['return', 'throw'] as const) {
  test(`late visual ${outcome} preserves the FAILED cache after three consecutive lease losses`, async (context) => {
    const f = await fixture(); let release!: () => void; let entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; });
    const closeProvider = await localProvider(context, async () => { entered(); await gate; if (outcome === 'throw') throw new Error('late fake failure'); return 'late stale output'; }); let old: Promise<unknown> | undefined;
    try {
      const job = await f.make(); old = new JobRunner(f.jobs, 'stalled-visual').run(job.id, f.handler); await started; await f.expire(job.id);
      for (let count = 2; count <= 3; count += 1) {
        const claimed = await f.jobs.claim(job.id, `crash-${count}`, 30_000); assert.ok(claimed);
        await f.jobs.withCurrentAttemptFence(job.id, claimed.attemptId, (scope) => f.v3.beginVisualAttempt(scope, claimed.job, f.assetId, '7::1000', 'lease-visual', '1'));
        await f.expire(job.id);
      }
      const before = (await f.db.query('select * from asset_visual_profiles where asset_id=$1', [f.assetId])).rows[0]; assert.equal(before.status, 'FAILED'); assert.equal((await f.jobs.get(job.id))?.state, 'FAILED');
      release(); await old; assert.deepEqual((await f.db.query('select * from asset_visual_profiles where asset_id=$1', [f.assetId])).rows[0], before);
      assert.equal(await f.jobs.claim(job.id, 'fourth', 30_000), null);
    } finally { release(); if (old) await old; await closeProvider(); await f.close(); }
  });
}

test('late semantic embedding cannot replace vectors attached to a newer global READY profile', async (context) => {
  const f = await fixture(); let release!: () => void; let entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; });
  const closeProvider = await localProvider(context, async () => 'old completed profile', async () => { entered(); await gate; return [1, 0]; }); let old: Promise<unknown> | undefined;
  try {
    const job = await f.make(); old = new JobRunner(f.jobs, 'old-embedding').run(job.id, f.handler); await started;
    const replacement = await f.make(); const claimed = await f.jobs.claim(replacement.id, 'new-global-profile', 30_000); assert.ok(claimed);
    await f.jobs.withCurrentAttemptFence(replacement.id, claimed.attemptId, async (scope) => {
      await f.v3.beginVisualAttempt(scope, claimed.job, f.assetId, '7::1000', 'lease-visual', '1');
      await f.v3.persistVisualProfile({ assetId: f.assetId, summary: 'new current profile', tags: [], recommendedTimestampsMs: [0], modelProvider: 'QWEN_VL', modelName: 'lease-visual', modelVersion: '1', promptVersion: 'qwen-visual-v2', analysisVersion: 'asset-profile-v2', createdAt: new Date().toISOString() }, '7::1000', scope);
      await f.v3.persistSemanticEmbedding({ assetId: f.assetId, sourceFingerprint: '7::1000', provider: 'QWEN_EMBEDDING', model: 'text-embedding-v3', vector: [0, 1] }, scope);
    });
    const before = (await f.db.query('select * from asset_semantic_embeddings where asset_id=$1', [f.assetId])).rows[0];
    release(); await old; assert.deepEqual((await f.db.query('select * from asset_semantic_embeddings where asset_id=$1', [f.assetId])).rows[0], before);
    assert.equal((await f.db.query('select summary from asset_visual_profiles where asset_id=$1', [f.assetId])).rows[0].summary, 'new current profile');
  } finally { release(); if (old) await old; await closeProvider(); await f.close(); }
});

test('visual profile and evidence mutations roll back with a failed published executor transaction', async () => {
  const f = await fixture();
  try {
    const job = await f.make(); const claimed = await f.jobs.claim(job.id, 'atomic-visual', 30_000); assert.ok(claimed);
    await f.jobs.withCurrentAttemptFence(job.id, claimed.attemptId, (scope) => f.v3.beginVisualAttempt(scope, claimed.job, f.assetId, '7::1000', 'lease-visual', '1'));
    const before = (await f.db.query('select * from asset_visual_profiles where asset_id=$1', [f.assetId])).rows[0];
    await assert.rejects(f.jobs.withCurrentAttemptFence(job.id, claimed.attemptId, async (scope) => {
      await f.v3.assertPendingVisualOwner(scope, claimed.job, f.assetId, '7::1000', 'lease-visual:1:qwen-visual-v2:asset-profile-v2');
      await f.v3.persistVisualProfile({ assetId: f.assetId, summary: 'rolled back', tags: [], recommendedTimestampsMs: [0], modelProvider: 'QWEN_VL', modelName: 'lease-visual', modelVersion: '1', promptVersion: 'qwen-visual-v2', analysisVersion: 'asset-profile-v2', createdAt: new Date().toISOString() }, '7::1000', scope);
      throw new Error('owner transaction veto');
    }), /owner transaction veto/);
    assert.deepEqual((await f.db.query('select * from asset_visual_profiles where asset_id=$1', [f.assetId])).rows[0], before);
  } finally { await f.close(); }
});

test('a delayed begin reuses matching successful cache committed after its initial read', async () => {
  const f = await fixture();
  try {
    const old = await f.make(); const current = await f.jobs.claim(old.id, 'delayed-begin', 30_000); assert.ok(current);
    assert.equal((await f.db.query('select asset_id from asset_visual_profiles where asset_id=$1', [f.assetId])).rowCount, 0);
    const profile = { assetId: f.assetId, summary: 'concurrent success', tags: [], recommendedTimestampsMs: [0], modelProvider: 'QWEN_VL', modelName: 'lease-visual', modelVersion: '1', promptVersion: 'qwen-visual-v2', analysisVersion: 'asset-profile-v2', createdAt: new Date().toISOString() };
    await f.v3.persistVisualProfile(profile, '7::1000');
    const before = (await f.db.query('select * from asset_visual_profiles where asset_id=$1', [f.assetId])).rows[0];
    const result = await f.jobs.withCurrentAttemptFence(old.id, current.attemptId, (scope) => f.v3.beginVisualAttempt(scope, current.job, f.assetId, '7::1000', 'lease-visual', '1'));
    assert.equal(result.executed, true); if (result.executed) assert.deepEqual(result.value, profile);
    assert.deepEqual((await f.db.query('select * from asset_visual_profiles where asset_id=$1', [f.assetId])).rows[0], before);
  } finally { await f.close(); }
});

test('visual failure port redacts the original callback diagnostic before owner persistence', async () => {
  const f = await fixture();
  try {
    const job = await f.make(); const claimed = await f.jobs.claim(job.id, 'redaction-visual', 30_000); assert.ok(claimed);
    await f.jobs.withCurrentAttemptFence(job.id, claimed.attemptId, (scope) => f.v3.beginVisualAttempt(scope, claimed.job, f.assetId, '7::1000', 'lease-visual', '1'));
    const diagnostic = { code: 'QWEN_HTTP_401', message: 'https://user:fixture-url-secret@provider.invalid timeout password=fixture-password Bearer fixture-bearer' };
    await f.jobs.fail(job.id, claimed.attemptId, diagnostic, false, (scope) => f.v3.failPendingVisualAttempt(scope, claimed.job, f.assetId, '7::1000', 'lease-visual:1:qwen-visual-v2:asset-profile-v2', diagnostic));
    const stored = (await f.db.query('select error from asset_visual_profiles where asset_id=$1', [f.assetId])).rows[0].error;
    assert.equal(stored.code, 'QWEN_HTTP_401'); assert.match(stored.message, /timeout/); assert.match(stored.message, /REDACTED/);
    assert.doesNotMatch(JSON.stringify(stored), /fixture-url-secret|fixture-password|fixture-bearer/);
    assert.doesNotMatch(JSON.stringify((await f.db.query('select error from jobs where id=$1', [job.id])).rows[0]), /fixture-url-secret|fixture-password|fixture-bearer/);
  } finally { await f.close(); }
});

test('representative frame generation publishes real JPEG files from an attempt-specific directory', async () => {
  const f = await fixture();
  try {
    await f.db.query('delete from asset_representative_frames where asset_id=$1', [f.assetId]); await generateFixtureVideo(f.sourcePath, process.env.FFMPEG_PATH || 'ffmpeg', 'blue', 1);
    const job = await f.make('GENERATE_REPRESENTATIVE_FRAMES');
    // Frame-only work has no Qwen dependency; the fixture config is irrelevant.
    await f.db.query("update jobs set payload=payload-'analysisConfig' where id=$1", [job.id]);
    assert.equal((await new JobRunner(f.jobs, 'frame-generator').run(job.id, f.handler)).state, 'SUCCEEDED');
    const attempt = (await f.jobs.attempts(job.id))[0]!; const frames = (await f.db.query<{ frame_key: string }>('select frame_key from asset_representative_frames where asset_id=$1', [f.assetId])).rows;
    assert.equal(frames.length, 5); for (const frame of frames) { assert.ok(frame.frame_key.includes(attempt.id)); assert.ok(frame.frame_key.includes(job.id)); }
  } finally { await f.close(); }
});
