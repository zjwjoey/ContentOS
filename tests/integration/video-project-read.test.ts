import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { AssetCatalogService, AssetService } from '../../packages/modules/asset/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { VideoProjectReadService, VideoService } from '../../packages/modules/video/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { createVideoLeaseCancellationHandler } from '../../workers/video-worker/src/video-handler.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';

test('Video project read service returns the newest successful Render target', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Video project read ' + randomUUID());
  const oldAssetId = 'asset-old-' + randomUUID();
  const oldManifestId = 'manifest-old-' + randomUUID();
  const oldRenderId = 'render-old-' + randomUUID();
  const currentAssetId = 'asset-current-' + randomUUID();
  const currentManifestId = 'manifest-current-' + randomUUID();
  const currentRenderId = 'render-current-' + randomUUID();
  try {
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [oldAssetId, project.id, 'VIDEO_RENDER', 'sha256:old', 100, 'renders/' + oldAssetId + '.mp4', 'READY', {}]);
    await db.query('insert into edit_manifests (id, project_id, revision, schema_version, manifest, status) values ($1, $2, $3, $4, $5, $6)', [oldManifestId, project.id, 1, 'EDIT_MANIFEST_V0', {}, 'SUPERSEDED']);
    await db.query('insert into renders (id, project_id, manifest_id, status, output_asset_id, finished_at) values ($1, $2, $3, $4, $5, $6)', [oldRenderId, project.id, oldManifestId, 'SUCCEEDED', oldAssetId, '2026-08-22T00:10:00Z']);
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [currentAssetId, project.id, 'VIDEO_RENDER', 'sha256:current', 100, 'renders/' + currentAssetId + '.mp4', 'READY', {}]);
    await db.query('insert into edit_manifests (id, project_id, revision, schema_version, manifest, status) values ($1, $2, $3, $4, $5, $6)', [currentManifestId, project.id, 2, 'EDIT_MANIFEST_V0', {}, 'PERSISTED']);
    await db.query('insert into renders (id, project_id, manifest_id, status, output_asset_id, finished_at) values ($1, $2, $3, $4, $5, $6)', [currentRenderId, project.id, currentManifestId, 'SUCCEEDED', currentAssetId, '2026-08-22T00:01:00Z']);
    const current = await new VideoProjectReadService(db).getCurrentRender(project.id);
    assert.deepEqual(current, { renderId: currentRenderId, outputAssetId: currentAssetId });
  } finally {
    await db.query('delete from renders where project_id = $1', [project.id]);
    await db.query('delete from edit_manifests where project_id = $1', [project.id]);
    await db.query('delete from assets where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]); await db.end();
  }
});

test('Video planning rejects a source asset owned by another project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-video-scope-'));
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const owner = await new ProjectService(db).create('Video source owner ' + randomUUID());
  const requester = await new ProjectService(db).create('Video source requester ' + randomUUID());
  const jobs = new JobService(db);
  const storage = new LocalStorageProvider(join(root, 'storage'));
  const video = new VideoService(db, storage, jobs, new AssetCatalogService(db));
  const assetId = 'asset-foreign-video-' + randomUUID();
  let jobId: string | undefined;
  try {
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, owner.id, 'VIDEO', 'sha256:foreign-video', 100, 'source/' + assetId + '.mp4', 'READY', { durationMs: 1000 }]);
    const job = await video.createJob({ projectId: requester.id, videoAssetIds: [assetId], targetDurationMs: 1000, seed: 1 });
    jobId = job.id;
    await assert.rejects(() => video.planJob(job), /video assets are unavailable/);
  } finally {
    if (jobId) {
      await db.query('delete from job_events where job_id = $1', [jobId]);
      await db.query('delete from job_attempts where job_id = $1', [jobId]);
      await db.query('delete from jobs where id = $1', [jobId]);
    }
    await db.query('delete from assets where id = $1', [assetId]);
    await db.query('delete from content_projects where id in ($1, $2)', [owner.id, requester.id]);
    await db.end(); await rm(root, { recursive: true, force: true });
  }
});

test('Asset Catalog reports the requesting project for a deduplicated source asset', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const owner = await new ProjectService(db).create('Asset source owner ' + randomUUID());
  const requester = await new ProjectService(db).create('Asset source requester ' + randomUUID());
  const assetId = 'asset-deduplicated-video-' + randomUUID();
  const catalog = new AssetCatalogService(db);
  try {
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, owner.id, 'VIDEO', 'sha256:deduplicated-video', 100, 'source/' + assetId + '.mp4', 'READY', { durationMs: 1000 }]);
    await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3)', [requester.id, assetId, 'SOURCE']);
    const source = await catalog.getReadySourceAsset(requester.id, assetId, 'VIDEO');
    assert.equal(source?.projectId, requester.id);
  } finally {
    await db.query('delete from project_assets where asset_id = $1', [assetId]);
    await db.query('delete from assets where id = $1', [assetId]);
    await db.query('delete from content_projects where id in ($1, $2)', [owner.id, requester.id]);
    await db.end();
  }
});

test('Video planning reuses a successful Render after its source association is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-video-idempotency-'));
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Video planning idempotency ' + randomUUID());
  const assetId = 'asset-video-idempotency-' + randomUUID();
  const jobs = new JobService(db);
  const video = new VideoService(db, new LocalStorageProvider(join(root, 'storage')), jobs, new AssetCatalogService(db));
  let jobId: string | undefined;
  try {
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO', 'sha256:video-idempotency', 100, 'source/' + assetId + '.mp4', 'READY', { durationMs: 1000 }]);
    await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3)', [project.id, assetId, 'SOURCE']);
    const job = await video.createJob({ projectId: project.id, videoAssetIds: [assetId], targetDurationMs: 1000, seed: 1, idempotencyKey: 'video-plan-retry-' + randomUUID() });
    jobId = job.id;
    const first = await video.planJob(job);
    const claimed = await jobs.claim(job.id, 'video-worker-success', 30_000);
    assert.ok(claimed);
    assert.equal((await jobs.withCurrentAttemptFence(job.id, claimed.attemptId, (scope) => video.startRender(first.renderId, scope, { seed: 1 }))).executed, true);
    assert.equal((await jobs.succeedWithCurrentAttempt(job.id, claimed.attemptId, (scope) => video.completeRender(first.renderId, scope, assetId, { outputAssetId: assetId }))).executed, true);
    await db.query('delete from project_assets where project_id = $1 and asset_id = $2', [project.id, assetId]);
    const retried = await video.planJob(job);
    const counts = await db.query<{ manifests: string; renders: string }>('select (select count(*)::text from edit_manifests where project_id = $1) as manifests, (select count(*)::text from renders where project_id = $1) as renders', [project.id]);
    assert.deepEqual({ manifestId: retried.manifestId, renderId: retried.renderId }, { manifestId: first.manifestId, renderId: first.renderId });
    assert.equal(retried.renderStatus, 'SUCCEEDED');
    assert.equal(retried.outputAssetId, assetId);
    assert.deepEqual(counts.rows[0], { manifests: '1', renders: '1' });
  } finally {
    await db.query('delete from renders where project_id = $1', [project.id]);
    await db.query('delete from edit_manifests where project_id = $1', [project.id]);
    if (jobId) {
      await db.query('delete from job_events where job_id = $1', [jobId]);
      await db.query('delete from job_attempts where job_id = $1', [jobId]);
      await db.query('delete from jobs where id = $1', [jobId]);
    }
    await db.query('delete from project_assets where project_id = $1', [project.id]);
    await db.query('delete from assets where id = $1', [assetId]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end(); await rm(root, { recursive: true, force: true });
  }
});

test('a stale Video attempt cannot overwrite the current Render attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-video-attempt-fence-'));
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Video attempt fence ' + randomUUID());
  const assetId = 'asset-video-attempt-fence-' + randomUUID();
  const jobs = new JobService(db);
  const video = new VideoService(db, new LocalStorageProvider(join(root, 'storage')), jobs, new AssetCatalogService(db));
  let jobId: string | undefined;
  try {
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO', 'sha256:video-attempt-fence', 100, 'source/' + assetId + '.mp4', 'READY', { durationMs: 1000 }]);
    await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3)', [project.id, assetId, 'SOURCE']);
    const job = await video.createJob({ projectId: project.id, videoAssetIds: [assetId], targetDurationMs: 1000, seed: 1, idempotencyKey: 'video-attempt-fence-' + randomUUID() });
    jobId = job.id;
    const plan = await video.planJob(job);

    const expired = await jobs.claim(job.id, 'video-worker-expired', 1);
    assert.ok(expired);
    const expiredStart = await jobs.withCurrentAttemptFence(job.id, expired.attemptId, (scope) => video.startRender(plan.renderId, scope, { seed: 1 }));
    assert.deepEqual(expiredStart, { executed: true, value: true });
    await jobs.reconcileExpiredLeases(new Date(Date.now() + 2_000));

    let staleAssetImports = 0;
    const staleCompletion = await jobs.withCurrentAttemptFence(job.id, expired.attemptId, async () => {
      staleAssetImports += 1;
      return true;
    });
    assert.deepEqual(staleCompletion, { executed: false });
    assert.equal(staleAssetImports, 0);

    const current = await jobs.claim(job.id, 'video-worker-current', 30_000);
    assert.ok(current);
    const currentStart = await jobs.withCurrentAttemptFence(job.id, current.attemptId, (scope) => video.startRender(plan.renderId, scope, { seed: 1 }));
    assert.deepEqual(currentStart, { executed: true, value: true });
    const currentCompletion = await jobs.succeedWithCurrentAttempt(job.id, current.attemptId, (scope) => video.completeRender(plan.renderId, scope, assetId, { outputAssetId: assetId }));
    assert.equal(currentCompletion.executed, true);
    if (currentCompletion.executed) assert.equal(currentCompletion.value, true);

    const render = await db.query<{ status: string; output_asset_id: string; attempt_id: string; attempt_number: number }>('select status, output_asset_id, attempt_id, attempt_number from renders where id = $1', [plan.renderId]);
    assert.deepEqual(render.rows[0], { status: 'SUCCEEDED', output_asset_id: assetId, attempt_id: current.attemptId, attempt_number: 2 });
  } finally {
    await db.query('delete from renders where project_id = $1', [project.id]);
    await db.query('delete from edit_manifests where project_id = $1', [project.id]);
    if (jobId) {
      await db.query('delete from job_events where job_id = $1', [jobId]);
      await db.query('delete from job_attempts where job_id = $1', [jobId]);
      await db.query('delete from jobs where id = $1', [jobId]);
    }
    await db.query('delete from project_assets where project_id = $1', [project.id]);
    await db.query('delete from assets where id = $1', [assetId]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end(); await rm(root, { recursive: true, force: true });
  }
});

test('lease reconciliation atomically closes a crashed Video Render and its cancelled Job attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-video-cancel-'));
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Video cancellation ' + randomUUID());
  const assetId = 'asset-video-cancel-' + randomUUID();
  const jobs = new JobService(db);
  const storage = new LocalStorageProvider(join(root, 'storage'));
  const video = new VideoService(db, storage, jobs, new AssetCatalogService(db));
  let jobId: string | undefined;
  try {
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO', 'sha256:video-cancel', 100, 'source/' + assetId + '.mp4', 'READY', { durationMs: 1000 }]);
    await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3)', [project.id, assetId, 'SOURCE']);
    const job = await video.createJob({ projectId: project.id, videoAssetIds: [assetId], targetDurationMs: 1000, seed: 1, idempotencyKey: 'video-cancel-' + randomUUID() });
    jobId = job.id;
    const plan = await video.planJob(job);
    const claimed = await jobs.claim(job.id, 'video-worker-cancel', 30_000);
    assert.ok(claimed);
    assert.equal((await jobs.withCurrentAttemptFence(job.id, claimed.attemptId, (scope) => video.startRender(plan.renderId, scope))).executed, true);
    const attemptDirectory = join(storage.root, 'renders');
    const attemptOutput = join(attemptDirectory, `${job.id}-${claimed.attemptId}.mp4`);
    const attemptPart = `${attemptOutput}.test.part.mp4`;
    await mkdir(attemptDirectory, { recursive: true });
    await writeFile(attemptOutput, 'crashed-output');
    await writeFile(attemptPart, 'crashed-part');
    await jobs.requestCancel(job.id);
    assert.equal(await jobs.reconcileExpiredLeases(new Date(Date.now() + 60_000), createVideoLeaseCancellationHandler(video, storage)), 1);
    assert.equal((await jobs.get(job.id))?.state, 'CANCELLED');
    assert.equal((await jobs.attempts(job.id))[0]?.status, 'CANCELLED');
    assert.equal((await db.query<{ status: string }>('select status from renders where id = $1', [plan.renderId])).rows[0]?.status, 'CANCELLED');
    await assert.rejects(access(attemptOutput));
    await assert.rejects(access(attemptPart));
  } finally {
    await db.query('delete from renders where project_id = $1', [project.id]);
    await db.query('delete from edit_manifests where project_id = $1', [project.id]);
    if (jobId) { await db.query('delete from job_events where job_id = $1', [jobId]); await db.query('delete from job_attempts where job_id = $1', [jobId]); await db.query('delete from jobs where id = $1', [jobId]); }
    await db.query('delete from project_assets where project_id = $1', [project.id]);
    await db.query('delete from assets where id = $1', [assetId]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end(); await rm(root, { recursive: true, force: true });
  }
});

test('failed atomic Video finalization does not leave a READY output Asset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-video-atomic-finalize-'));
  const outputPath = join(root, 'attempt-output.mp4');
  await writeFile(outputPath, `attempt-output-${randomUUID()}`);
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Video atomic finalization ' + randomUUID());
  const sourceId = 'asset-video-atomic-source-' + randomUUID();
  const jobs = new JobService(db);
  const storage = new LocalStorageProvider(join(root, 'storage'));
  const assets = new AssetService(db, storage);
  const video = new VideoService(db, storage, jobs, new AssetCatalogService(db));
  let jobId: string | undefined;
  try {
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [sourceId, project.id, 'VIDEO', 'sha256:video-atomic-source', 100, 'source/' + sourceId + '.mp4', 'READY', { durationMs: 1000 }]);
    await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3)', [project.id, sourceId, 'SOURCE']);
    const job = await video.createJob({ projectId: project.id, videoAssetIds: [sourceId], targetDurationMs: 1000, seed: 1, idempotencyKey: 'video-atomic-finalize-' + randomUUID() });
    jobId = job.id;
    const plan = await video.planJob(job);
    const claimed = await jobs.claim(job.id, 'video-worker-atomic', 30_000);
    assert.ok(claimed);
    await jobs.withCurrentAttemptFence(job.id, claimed.attemptId, (scope) => video.startRender(plan.renderId, scope));
    const outputInput = { projectId: project.id, sourcePath: outputPath, kind: 'VIDEO_RENDER' };
    const preparedOutput = await assets.prepareFile(outputInput);
    await assert.rejects(jobs.succeedWithCurrentAttempt(job.id, claimed.attemptId, async (scope) => {
      await assets.commitPrepared(outputInput, preparedOutput, scope);
      const completed = await video.completeRender('missing-render', scope, sourceId, {});
      if (!completed) throw new Error('render completion rejected');
      return { unreachable: true };
    }), /render completion rejected/);
    assert.equal((await db.query("select 1 from assets where project_id = $1 and kind = 'VIDEO_RENDER'", [project.id])).rowCount, 0);
    assert.equal((await jobs.get(job.id))?.state, 'RUNNING');
  } finally {
    await db.query('delete from renders where project_id = $1', [project.id]);
    await db.query('delete from edit_manifests where project_id = $1', [project.id]);
    if (jobId) { await db.query('delete from job_events where job_id = $1', [jobId]); await db.query('delete from job_attempts where job_id = $1', [jobId]); await db.query('delete from jobs where id = $1', [jobId]); }
    await db.query('delete from project_assets where project_id = $1', [project.id]);
    await db.query('delete from assets where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end(); await rm(root, { recursive: true, force: true });
  }
});

test('concurrent Video Jobs leave exactly one current Manifest for a project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-video-concurrency-'));
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Video planning concurrency ' + randomUUID());
  const assetId = 'asset-video-concurrency-' + randomUUID();
  const jobs = new JobService(db);
  const video = new VideoService(db, new LocalStorageProvider(join(root, 'storage')), jobs, new AssetCatalogService(db));
  const jobIds: string[] = [];
  try {
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO', 'sha256:video-concurrency', 100, 'source/' + assetId + '.mp4', 'READY', { durationMs: 1000 }]);
    await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3)', [project.id, assetId, 'SOURCE']);
    const firstJob = await video.createJob({ projectId: project.id, videoAssetIds: [assetId], targetDurationMs: 1000, seed: 1, idempotencyKey: 'video-plan-concurrent-first-' + randomUUID() });
    const secondJob = await video.createJob({ projectId: project.id, videoAssetIds: [assetId], targetDurationMs: 1000, seed: 2, idempotencyKey: 'video-plan-concurrent-second-' + randomUUID() });
    jobIds.push(firstJob.id, secondJob.id);
    const plans = await Promise.all([video.planJob(firstJob), video.planJob(secondJob)]);
    const manifests = await db.query<{ revision: number; status: string }>('select revision, status from edit_manifests where project_id = $1 order by revision', [project.id]);
    const renders = await db.query<{ count: string }>('select count(*)::text as count from renders where project_id = $1', [project.id]);
    assert.notEqual(plans[0].manifestId, plans[1].manifestId);
    assert.deepEqual(manifests.rows.map((manifest) => manifest.status), ['SUPERSEDED', 'PERSISTED']);
    assert.equal(renders.rows[0]?.count, '2');
  } finally {
    await db.query('delete from renders where project_id = $1', [project.id]);
    await db.query('delete from edit_manifests where project_id = $1', [project.id]);
    if (jobIds.length) await db.query('delete from jobs where id = any($1::text[])', [jobIds]);
    await db.query('delete from project_assets where project_id = $1', [project.id]);
    await db.query('delete from assets where id = $1', [assetId]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end(); await rm(root, { recursive: true, force: true });
  }
});
