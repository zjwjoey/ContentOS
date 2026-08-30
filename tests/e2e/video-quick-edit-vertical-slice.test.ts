import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { AssetCatalogService, AssetService } from '../../packages/modules/asset/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { VideoQuickEditService, VideoService } from '../../packages/modules/video/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { generateFixtureVideo, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
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

test('Quick Edit v2 renders the selected immutable timeline through the Video Worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-video-quick-edit-e2e-'));
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const storage = new LocalStorageProvider(join(root, 'storage'));
  const projects = new ProjectService(db);
  const project = await projects.create(`Quick Edit E2E ${randomUUID()}`);
  const assetService = new AssetService(db, storage, (path) => probeMedia(path, ffprobePath));
  const colors = ['red', 'green', 'blue'];
  let worker: ReturnType<typeof createVideoWorker> | undefined;
  let renderJobId: string | undefined;
  let invalidJobId: string | undefined;
  let digestJobId: string | undefined;
  try {
    const sources = [];
    for (const [index, color] of colors.entries()) {
      const path = join(root, `${index}-${color}.mp4`);
      await generateFixtureVideo(path, ffmpegPath, color);
      sources.push(await assetService.importFile({ projectId: project.id, sourcePath: path, kind: 'VIDEO' }));
    }
    const parentId = `manifest-e2e-parent-${randomUUID()}`;
    await db.query('insert into edit_manifests (id, project_id, revision, schema_version, manifest, status) values ($1, $2, $3, $4, $5, $6)', [parentId, project.id, 1, 'EDIT_MANIFEST_V0', { schemaVersion: 'EDIT_MANIFEST_V0', projectId: project.id, seed: 9, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline: sources.map((source, index) => ({ assetId: source.id, sourcePath: 'unused', sourceInMs: 0, durationMs: 1_000, transition: index === 1 ? 'fade' : 'cut' })), audio: { volume: 1 }, output: { format: 'mp4', videoCodec: 'mpeg4', audioCodec: 'aac' } }, 'PERSISTED']);
    const quickEdit = new VideoQuickEditService(db, new AssetCatalogService(db));
    const version = await quickEdit.createVersion({ projectId: project.id, parentManifestId: parentId, operations: [{ type: 'REMOVE', clipIndex: 0 }, { type: 'TRIM', clipIndex: 0, sourceInMs: 200, durationMs: 700 }], createdBy: 'e2e', idempotencyKey: `e2e-${randomUUID()}` });
    assert.equal(version.revision, 2);
    const jobs = new JobService(db);
    const video = new VideoService(db, storage, jobs, new AssetCatalogService(db));
    const renderJob = await video.createManifestRenderJob(project.id, version.id);
    renderJobId = renderJob.id;
    assert.equal((renderJob.payload as { manifestRevision: number }).manifestRevision, 2);
    const digest = (renderJob.payload as { manifestDigest: string }).manifestDigest;
    const invalidJob = await jobs.create({ id: `job-invalid-${randomUUID()}`, projectId: project.id, type: 'VIDEO_RENDER', payload: { projectId: project.id, manifestId: version.id, manifestRevision: 999, manifestDigest: digest }, idempotencyKey: `invalid-${randomUUID()}`, maxAttempts: 1 });
    invalidJobId = invalidJob.id;
    await assert.rejects(() => video.planJob(invalidJob), /REVISION_CONFLICT/);
    const digestJob = await jobs.create({ id: `job-digest-${randomUUID()}`, projectId: project.id, type: 'VIDEO_RENDER', payload: { projectId: project.id, manifestId: version.id, manifestRevision: 2, manifestDigest: digest }, idempotencyKey: `digest-${randomUUID()}`, maxAttempts: 1 });
    digestJobId = digestJob.id;
    const currentManifest = await db.query<{ manifest: Record<string, unknown> }>('select manifest from edit_manifests where id = $1', [version.id]);
    await db.query('update edit_manifests set manifest = $2 where id = $1', [version.id, { ...currentManifest.rows[0]!.manifest, seed: 10 }]);
    await assert.rejects(() => video.planJob(digestJob), /DIGEST_CONFLICT/);
    await db.query('update edit_manifests set manifest = $2 where id = $1', [version.id, currentManifest.rows[0]!.manifest]);
    worker = createVideoWorker({ db, storage, assets: assetService, jobs, video, ffmpegPath, ffprobePath, workerId: `video-quick-edit-${randomUUID()}`, pollIntervalMs: 25 });
    await worker.start();
    const result = await waitForJob(jobs, renderJob.id);
    assert.equal(result?.state, 'SUCCEEDED');
    const output = result?.result as { manifestId: string; outputAssetId: string };
    assert.equal(output.manifestId, version.id);
    const render = await db.query<{ manifest_id: string; status: string; output_asset_id: string }>('select manifest_id, status, output_asset_id from renders where job_id = $1', [renderJob.id]);
    assert.deepEqual(render.rows[0], { manifest_id: version.id, status: 'SUCCEEDED', output_asset_id: output.outputAssetId });
    const media = await db.query<{ storage_key: string }>('select storage_key from assets where id = $1', [output.outputAssetId]);
    const probe = await probeMedia(storage.objectPath(media.rows[0]!.storage_key), ffprobePath);
    assert.equal(probe.width, 1080); assert.equal(probe.height, 1920); assert.equal(probe.format, 'mp4');
  } finally {
    if (worker) await worker.shutdown('test');
    for (const jobId of [renderJobId, invalidJobId, digestJobId].filter((id): id is string => Boolean(id))) { await db.query('delete from job_events where job_id = $1', [jobId]); await db.query('delete from job_attempts where job_id = $1', [jobId]); }
    await db.query('delete from renders where project_id = $1', [project.id]);
    await db.query('delete from edit_manifests where project_id = $1', [project.id]);
    await db.query('delete from jobs where project_id = $1', [project.id]);
    await db.query('delete from project_assets where project_id = $1', [project.id]);
    await db.query('delete from assets where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end(); await rm(root, { recursive: true, force: true });
  }
});
