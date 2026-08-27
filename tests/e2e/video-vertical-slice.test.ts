import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { AssetCatalogService, AssetService } from '../../packages/modules/asset/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { VideoService } from '../../packages/modules/video/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { generateFixtureAudio, generateFixtureVideo, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { createVideoWorker } from '../../workers/video-worker/src/main.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
const fontFile = process.env.FFMPEG_FONT_FILE || 'C:\\Windows\\Fonts\\msyh.ttc';

async function waitForTerminalJob(jobs: JobService, jobId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await jobs.get(jobId);
    if (job && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return jobs.get(jobId);
}

test('Project -> Asset -> Job -> Manifest -> Worker -> Render -> output Asset vertical slice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-video-e2e-'));
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const storage = new LocalStorageProvider(join(root, 'storage'));
  const projects = new ProjectService(db);
  const project = await projects.create('Video Vertical Slice');
  const assets = new AssetService(db, storage, (path) => probeMedia(path, ffprobePath));
  const colors = ['red', 'green', 'blue', 'yellow', 'purple', 'orange', 'pink', 'cyan', 'white', 'black'];
  const sources = await Promise.all(colors.map(async (color, index) => {
    const path = join(root, index === 0 ? '素材-红.mp4' : `${color}.mp4`);
    await generateFixtureVideo(path, ffmpegPath, color);
    return assets.importFile({ projectId: project.id, sourcePath: path, kind: 'VIDEO' });
  }));
  const voicePath = join(root, '配音.wav');
  await generateFixtureAudio(voicePath, ffmpegPath);
  const voice = await assets.importFile({ projectId: project.id, sourcePath: voicePath, kind: 'AUDIO' });
  const jobs = new JobService(db);
  const video = new VideoService(db, storage, jobs, new AssetCatalogService(db));
  const job = await video.createJob({ projectId: project.id, videoAssetIds: sources.map((asset) => asset.id), voiceAssetId: voice.id, targetDurationMs: 4200, seed: 19, subtitleText: 'ContentOS 纵向切片' });
  const worker = createVideoWorker({ db, storage, assets, jobs, video, ffmpegPath, ffprobePath, fontFile, workerId: 'video-worker-e2e', pollIntervalMs: 25 });
  await worker.start();
  const result = await waitForTerminalJob(jobs, job.id);
  try {
    assert.equal(result?.state, 'SUCCEEDED');
    const payload = result?.result as { manifestId: string; renderId: string; outputAssetId: string };
    const manifest = await db.query<{ schema_version: string; manifest: { timeline: unknown[] } }>('select schema_version, manifest from edit_manifests where id = $1', [payload.manifestId]);
    assert.equal(manifest.rows[0]?.schema_version, 'EDIT_MANIFEST_V0');
    assert.ok((manifest.rows[0]?.manifest.timeline.length || 0) >= 3);
    const render = await db.query<{ status: string; output_asset_id: string; attempt_id: string; attempt_number: number }>('select status, output_asset_id, attempt_id, attempt_number from renders where id = $1', [payload.renderId]);
    assert.equal(render.rows[0]?.status, 'SUCCEEDED');
    assert.equal(render.rows[0]?.output_asset_id, payload.outputAssetId);
    assert.equal(render.rows[0]?.attempt_number, 1);
    const output = await db.query<{ storage_key: string; metadata: { originalName?: string } }>('select storage_key, metadata from assets where id = $1', [payload.outputAssetId]);
    assert.equal(output.rows[0]?.metadata.originalName, `${job.id}-${render.rows[0]?.attempt_id}.mp4`);
    await assert.rejects(access(join(storage.root, 'renders', `${job.id}-${render.rows[0]?.attempt_id}.mp4`)));
    assert.equal(await storage.exists(output.rows[0]!.storage_key), true);
    const probe = await probeMedia(storage.objectPath(output.rows[0]!.storage_key), ffprobePath);
    assert.equal(probe.width, 1080); assert.equal(probe.height, 1920); assert.equal(probe.format, 'mp4'); assert.equal(probe.audio, true);
    assert.ok(await projects.get(project.id));
    const api = await buildApi(db);
    const apiAssets = await api.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/assets` });
    assert.equal(apiAssets.statusCode, 200);
    assert.equal(apiAssets.json().items.length, 12);
    await api.close();
    const links = await db.query<{ count: string }>('select count(*)::text as count from project_assets where project_id = $1', [project.id]);
    assert.equal(links.rows[0]?.count, '12');
  } finally {
    await db.query('delete from job_events where job_id = $1', [job.id]);
    await db.query('delete from job_attempts where job_id = $1', [job.id]);
    await db.query('delete from renders where project_id = $1', [project.id]);
    await db.query('delete from edit_manifests where project_id = $1', [project.id]);
    await db.query('delete from jobs where id = $1', [job.id]);
    await db.query('delete from project_assets where project_id = $1', [project.id]);
    await db.query('delete from assets where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await worker.shutdown('test'); await db.end(); await rm(root, { recursive: true, force: true });
  }
});
