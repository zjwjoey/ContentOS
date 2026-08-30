import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { AssetImportService, AssetService } from '../../packages/modules/asset/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { generateFixtureVideo, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { createAssetWorker } from '../../workers/asset-worker/src/main.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';

async function cleanup(db: Awaited<ReturnType<typeof createDatabase>>, projectId: string, root: string): Promise<void> {
  await db.query('delete from project_assets where project_id = $1', [projectId]);
  await db.query('delete from asset_imports where project_id = $1', [projectId]);
  await db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [projectId]);
  await db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [projectId]);
  await db.query('delete from jobs where project_id = $1', [projectId]);
  await db.query('delete from assets where project_id = $1', [projectId]);
  await db.query('delete from content_projects where id = $1', [projectId]);
  await db.end();
  await rm(root, { recursive: true, force: true });
}

test('Asset Worker probes, promotes and deduplicates staged video imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-asset-worker-'));
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create(`Asset worker ${randomUUID()}`);
  const storage = new LocalStorageProvider(join(root, 'storage'));
  const source = join(root, 'source.mp4');
  await generateFixtureVideo(source, ffmpegPath, 'blue');
  const imports = new AssetImportService(db);
  const jobs = new JobService(db);
  const assets = new AssetService(db, storage, (path) => probeMedia(path, ffprobePath));
  const worker = createAssetWorker({ db, storage, imports, jobs, assets, ffprobePath, workerId: 'asset-worker-test' });
  await worker.start();
  try {
    const staged = await storage.stage(source);
    const stagedPath = relative(storage.root, staged.tempPath).replaceAll('\\', '/');
    const record = await imports.createStaged({
      projectId: project.id,
      originalName: 'source.mp4',
      kind: 'VIDEO',
      byteSize: staged.byteSize,
      stagedPath,
      correlationId: 'asset-worker-corr',
    });
    const job = await jobs.create({
      id: `job-asset-${randomUUID()}`,
      type: 'ASSET_IMPORT',
      projectId: project.id,
      payload: { schemaVersion: 'ASSET_IMPORT_V0', projectId: project.id, importId: record.id, correlationId: record.correlationId },
      idempotencyKey: `asset-job-${record.id}`,
      maxAttempts: 3,
    });
    await imports.attachJob(project.id, record.id, job.id);
    const result = (await worker.execute('asset.import', { jobId: job.id })) as { state: string; result?: { outputAssetId: string } };
    assert.equal(result.state, 'SUCCEEDED', JSON.stringify(await jobs.get(job.id)));
    const completed = await imports.get(project.id, record.id);
    assert.equal(completed?.state, 'READY');
    assert.ok(completed?.outputAssetId);
    assert.equal((await db.query('select count(*)::int as count from assets where project_id = $1', [project.id])).rows[0]?.count, 1);
    const secondStaged = await storage.stage(source);
    const secondPath = relative(storage.root, secondStaged.tempPath).replaceAll('\\', '/');
    const second = await imports.createStaged({
      projectId: project.id,
      originalName: 'duplicate.mp4',
      kind: 'VIDEO',
      byteSize: secondStaged.byteSize,
      stagedPath: secondPath,
      correlationId: 'asset-worker-corr-2',
    });
    const secondJob = await jobs.create({
      id: `job-asset-${randomUUID()}`,
      type: 'ASSET_IMPORT',
      projectId: project.id,
      payload: { schemaVersion: 'ASSET_IMPORT_V0', projectId: project.id, importId: second.id, correlationId: second.correlationId },
      idempotencyKey: `asset-job-${second.id}`,
      maxAttempts: 3,
    });
    await imports.attachJob(project.id, second.id, secondJob.id);
    const duplicate = (await worker.execute('asset.import', { jobId: secondJob.id })) as { state: string };
    assert.equal(duplicate.state, 'SUCCEEDED');
    assert.equal((await imports.get(project.id, second.id))?.state, 'DEDUPED');
    assert.equal((await db.query('select count(*)::int as count from assets where project_id = $1', [project.id])).rows[0]?.count, 1);
  } finally {
    await worker.shutdown('test');
    await cleanup(db, project.id, root);
  }
});

test('Asset Worker fails safely for a missing staged file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-asset-worker-missing-'));
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create(`Asset worker missing ${randomUUID()}`);
  const storage = new LocalStorageProvider(join(root, 'storage'));
  const imports = new AssetImportService(db);
  const jobs = new JobService(db);
  const assets = new AssetService(db, storage, (path) => probeMedia(path, ffprobePath));
  const record = await imports.createStaged({
    projectId: project.id,
    originalName: 'missing.mp4',
    kind: 'VIDEO',
    byteSize: 100,
    stagedPath: 'staging/missing.part',
    correlationId: 'missing',
  });
  const job = await jobs.create({
    id: `job-asset-${randomUUID()}`,
    type: 'ASSET_IMPORT',
    projectId: project.id,
    payload: { schemaVersion: 'ASSET_IMPORT_V0', projectId: project.id, importId: record.id, correlationId: record.correlationId },
    idempotencyKey: `asset-job-${record.id}`,
    maxAttempts: 1,
  });
  await imports.attachJob(project.id, record.id, job.id);
  const worker = createAssetWorker({ db, storage, imports, jobs, assets, ffprobePath, workerId: 'asset-worker-missing', autoConsume: false });
  await worker.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal((await jobs.get(job.id))?.state, 'QUEUED');
    const result = (await worker.execute('asset.import', { jobId: job.id })) as { state: string };
    assert.equal(result.state, 'FAILED');
    assert.equal((await imports.get(project.id, record.id))?.state, 'FAILED');
  } finally {
    await worker.shutdown('test');
    await cleanup(db, project.id, root);
  }
});
