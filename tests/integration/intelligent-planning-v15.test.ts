import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createDatabase } from '../../packages/database/src/client.js';
import { generateFixtureVideo, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { AssetCatalogService, AssetService } from '../../packages/modules/asset/src/index.js';
import { JobRunner, JobService } from '../../packages/modules/job/src/index.js';
import { VideoService } from '../../packages/modules/video/src/index.js';
import { MediaIntelligenceService, createFakeIntelligenceProviders, IntelligentPlanningService } from '../../packages/modules/intelligence/src/index.js';
import { createVideoJobHandler } from '../../workers/video-worker/src/video-handler.js';

const databaseUrl = process.env.CONTENTOS_INTELLIGENCE_TEST_DATABASE_URL;

test('shot-level planner persists candidates, analysis provenance, manifest revision and render job', { skip: !databaseUrl }, async () => {
  const db = await createDatabase(databaseUrl!); const root = await mkdtemp(join(tmpdir(), 'contentos-planning-v15-')); const storage = new LocalStorageProvider(root); const suffix = randomUUID();
  try {
    const sourcePath = join(root, 'fixture.mp4'); await generateFixtureVideo(sourcePath, process.env.FFMPEG_PATH || 'ffmpeg', 'blue', 6); const storageKey = `objects/${suffix}.mp4`; await mkdir(join(root, 'objects'), { recursive: true }); await copyFile(sourcePath, storage.objectPath(storageKey));
    const project = await new ProjectService(db).create(`Planning isolated ${suffix}`); const assetId = `planning-asset-${suffix}`;
    await db.query('insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [assetId, project.id, 'VIDEO', `sha256:planning-${suffix}`, 100, storageKey, 'READY', { durationMs: 6_000, width: 640, height: 360, tags: ['商品'], notes: '商品展示' }]); await db.query('insert into project_assets(project_id,asset_id,role) values ($1,$2,$3)', [project.id, assetId, 'SOURCE']);
    const intelligence = new MediaIntelligenceService(db, createFakeIntelligenceProviders(), { storage, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', keyframeRoot: join(root, 'keyframes') }); const run = await intelligence.createRun({ projectId: project.id, assetId }); await intelligence.analyzeRun(run.id);
    const jobs = new JobService(db); const video = new VideoService(db, storage, jobs, new AssetCatalogService(db)); const planning = new IntelligentPlanningService(db, { storage, video });
    const plan = await planning.createPlan({ projectId: project.id, assetIds: [assetId], sentences: [{ id: 's1', text: '商品展示', durationMs: 1_000 }], config: { schemaVersion: 'INTELLIGENT_PLANNER_CONFIG_V1', version: 'integration-v2', targetDurationMs: 1_000, minClipDurationMs: 1_000, maxClipDurationMs: 1_000, maxAssetReuse: 1, diversityWeight: .8 } });
    const stored = await planning.getPlan(project.id, plan.id); assert.equal(stored?.manifest.schemaVersion, 'EDIT_MANIFEST_V0'); assert.equal(stored?.candidates.length, 2); assert.equal(stored?.candidates.filter((candidate) => candidate.selected).length, 1); assert.equal(stored?.candidates.find((candidate) => candidate.selected)?.sourceInMs, 0); assert.ok(stored?.manifestId); assert.equal(stored?.videoRevisionId, stored?.manifestId); assert.ok(stored?.renderJobId); assert.equal(stored?.sourceAnalysisRunIds?.length, 1); assert.ok(stored?.quality.semanticMatch && stored.quality.semanticMatch > 0);
    const renderJob = await jobs.get(stored!.renderJobId!); assert.ok(renderJob); const assets = new AssetService(db, storage, (path) => probeMedia(path, process.env.FFPROBE_PATH || 'ffprobe')); const final = await new JobRunner(jobs, 'video-worker-v15-test').run(renderJob.id, createVideoJobHandler({ db, storage, assets, jobs, video, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', ffprobePath: process.env.FFPROBE_PATH || 'ffprobe' })); assert.equal(final.state, 'SUCCEEDED'); const render = (await db.query<{ status: string; output_asset_id: string }>('select status,output_asset_id from renders where job_id=$1', [renderJob.id])).rows[0]; assert.ok(render); assert.equal(render.status, 'SUCCEEDED'); assert.ok(render.output_asset_id); const output = (await db.query<{ storage_key: string }>('select storage_key from assets where id=$1', [render.output_asset_id])).rows[0]; assert.ok(output); const rendered = await probeMedia(storage.objectPath(output.storage_key), process.env.FFPROBE_PATH || 'ffprobe'); assert.equal(rendered.format, 'mp4'); assert.equal(rendered.width, 1080); assert.equal(rendered.height, 1920); assert.ok(rendered.durationMs > 0);
  } finally { await db.end(); await rm(root, { recursive: true, force: true }); }
});
