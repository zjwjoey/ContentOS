import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { AssetCatalogService, AssetImportService, AssetService } from '../../packages/modules/asset/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { StandaloneQuickEditService, VideoAdjustmentService, VideoService } from '../../packages/modules/video/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { generateFixtureAudio, generateFixtureVideo, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { createAssetWorker } from '../../workers/asset-worker/src/main.js';
import { createVideoWorker } from '../../workers/video-worker/src/main.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';

async function waitForJob(jobs: JobService, jobId: string): Promise<Awaited<ReturnType<JobService['get']>>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await jobs.get(jobId);
    if (job && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return jobs.get(jobId);
}

test('Standalone Quick Edit imports assets and renders an H.264/AAC output through both workers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-standalone-video-e2e-'));
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const storage = new LocalStorageProvider(join(root, 'storage'));
  const jobs = new JobService(db);
  const imports = new AssetImportService(db);
  const assets = new AssetService(db, storage, (path) => probeMedia(path, ffprobePath));
  const catalog = new AssetCatalogService(db);
  const video = new VideoService(db, storage, jobs, catalog);
  const adjustments = new VideoAdjustmentService(db, catalog);
  const standalone = new StandaloneQuickEditService(db, catalog, adjustments, video);
  let assetWorker: ReturnType<typeof createAssetWorker> | undefined;
  let videoWorker: ReturnType<typeof createVideoWorker> | undefined;
  let workspaceId = '';
  const jobIds: string[] = [];
  try {
    const session = await standalone.create({ sourceAssetIds: [], targetDurationMs: 2_000, seed: 12 });
    workspaceId = session.workspaceId;
    const videoPath = join(root, 'source.mp4'); await generateFixtureVideo(videoPath, ffmpegPath, 'blue');
    const audioPath = join(root, 'voice.wav'); await generateFixtureAudio(audioPath, ffmpegPath);
    for (const [path, kind] of [[videoPath, 'VIDEO'], [audioPath, 'AUDIO']] as const) {
      const staged = await storage.stageUpload(path.split(/[\\/]/).pop()!, createReadStream(path), 20 * 1024 * 1024);
      const record = await imports.createStaged({ workspaceId, originalName: staged.originalName, kind, byteSize: staged.byteSize, stagedPath: staged.stagedPath, correlationId: randomUUID() });
      const job = await jobs.create({ id: `job-${randomUUID()}`, projectId: null, workspaceId, type: 'ASSET_IMPORT', payload: { schemaVersion: 'ASSET_IMPORT_V0', workspaceId, importId: record.id, correlationId: record.correlationId }, idempotencyKey: `standalone-import:${record.id}`, maxAttempts: 2 });
      jobIds.push(job.id); await imports.attachWorkspaceJob(workspaceId, record.id, job.id);
    }
    assetWorker = createAssetWorker({ db, storage, assets, imports, jobs, ffprobePath, workerId: `asset-standalone-${randomUUID()}`, pollIntervalMs: 25 });
    await assetWorker.start();
    for (const jobId of jobIds) assert.equal((await waitForJob(jobs, jobId))?.state, 'SUCCEEDED');
    const readyVideos = await catalog.listReadyWorkspaceAssets(workspaceId, 'VIDEO');
    const readyVoices = await catalog.listReadyWorkspaceAssets(workspaceId, 'AUDIO', 'VOICE');
    assert.equal(readyVideos.length, 1); assert.equal(readyVoices.length, 1);
    const planned = await standalone.plan(session.id);
    const renderJob = await standalone.render(session.id); jobIds.push(renderJob.id);
    videoWorker = createVideoWorker({ db, storage, assets, jobs, video, ffmpegPath, ffprobePath, workerId: `video-standalone-${randomUUID()}`, pollIntervalMs: 25 });
    await videoWorker.start();
    const completed = await waitForJob(jobs, renderJob.id);
    assert.equal(completed?.state, 'SUCCEEDED');
    const result = completed?.result as { outputAssetId: string };
    const output = await db.query<{ storage_key: string }>('select storage_key from assets where id = $1', [result.outputAssetId]);
    const probe = await probeMedia(storage.objectPath(output.rows[0]!.storage_key), ffprobePath);
    assert.equal(probe.videoCodec, 'h264'); assert.equal(probe.audioCodec, 'aac'); assert.equal(probe.width, 1080); assert.equal(probe.height, 1920);
    const role = await db.query<{ role: string }>('select role from video_workspace_assets where workspace_id = $1 and asset_id = $2', [workspaceId, result.outputAssetId]);
    assert.deepEqual(role.rows, [{ role: 'OUTPUT' }]);
    assert.equal(planned.manifest.workspaceId, workspaceId);
  } finally {
    if (videoWorker) await videoWorker.shutdown('test');
    if (assetWorker) await assetWorker.shutdown('test');
    if (workspaceId) {
      await db.query('delete from job_events where job_id = any($1::text[])', [jobIds]);
      await db.query('delete from job_attempts where job_id = any($1::text[])', [jobIds]);
      await db.query('delete from renders where workspace_id = $1', [workspaceId]);
      await db.query('update video_quick_edit_sessions set current_manifest_id = null where workspace_id = $1', [workspaceId]);
      await db.query('delete from edit_manifests where workspace_id = $1', [workspaceId]);
      await db.query('delete from jobs where workspace_id = $1', [workspaceId]);
      await db.query('delete from video_quick_edit_sessions where workspace_id = $1', [workspaceId]);
      const linked = await db.query<{ asset_id: string }>('select asset_id from video_workspace_assets where workspace_id = $1', [workspaceId]);
      await db.query('delete from video_workspace_assets where workspace_id = $1', [workspaceId]);
      await db.query('delete from asset_imports where workspace_id = $1', [workspaceId]);
      await db.query('delete from video_workspaces where id = $1', [workspaceId]);
      await db.query('delete from assets where id = any($1::text[])', [linked.rows.map((row) => row.asset_id)]);
    }
    await db.end(); await rm(root, { recursive: true, force: true });
  }
});
