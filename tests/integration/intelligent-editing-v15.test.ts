import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createDatabase } from '../../packages/database/src/client.js';
import { generateFixtureVideo } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { JobRunner, JobService } from '../../packages/modules/job/src/index.js';
import { MEDIA_ANALYSIS, MediaIntelligenceService, createFakeIntelligenceProviders } from '../../packages/modules/intelligence/src/index.js';
import { createMediaAnalysisJobHandler } from '../../workers/media-intelligence-worker/src/handler.js';

const databaseUrl = process.env.CONTENTOS_INTELLIGENCE_TEST_DATABASE_URL;

test('isolated media intelligence job produces real shots and READY keyframes', { skip: !databaseUrl }, async () => {
  const db = await createDatabase(databaseUrl!); const root = await mkdtemp(join(tmpdir(), 'contentos-intelligence-v15-')); const storage = new LocalStorageProvider(root); const suffix = randomUUID();
  try {
    const sourcePath = join(root, 'fixture.mp4'); await generateFixtureVideo(sourcePath, process.env.FFMPEG_PATH || 'ffmpeg', 'blue', 6); const storageKey = `objects/${suffix}.mp4`; await mkdir(join(root, 'objects'), { recursive: true }); await copyFile(sourcePath, storage.objectPath(storageKey));
    const project = await new ProjectService(db).create(`Intelligence isolated ${suffix}`); const assetId = `asset-${suffix}`;
    await db.query('insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [assetId, project.id, 'VIDEO', `sha256:${suffix}`, 100, storageKey, 'READY', { durationMs: 6_000, width: 640, height: 360, tags: ['人物'], transcript: '测试语音' }]);
    await db.query('insert into project_assets(project_id,asset_id,role) values ($1,$2,$3)', [project.id, assetId, 'SOURCE']);
    const intelligence = new MediaIntelligenceService(db, createFakeIntelligenceProviders(), { storage, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', keyframeRoot: join(root, 'keyframes') }); const jobs = new JobService(db); const run = await intelligence.createRun({ projectId: project.id, assetId });
    const job = await jobs.create({ id: `job-${suffix}`, type: MEDIA_ANALYSIS, projectId: project.id, workspaceId: null, payload: { schemaVersion: 'MEDIA_ANALYSIS_JOB_V1', projectId: project.id, assetId, runId: run.id, correlationId: `corr-${suffix}` }, idempotencyKey: `job-key-${suffix}`, maxAttempts: 3 }); await intelligence.attachJob(run.id, job.id);
    const final = await new JobRunner(jobs, 'test-media-intelligence').run(job.id, createMediaAnalysisJobHandler({ jobs, intelligence })); const results = await intelligence.results(project.id, run.id);
    assert.equal(final.state, 'SUCCEEDED'); assert.equal(results.run.status, 'SUCCEEDED'); assert.equal(results.shots.length, 2); assert.equal(results.asr[0]?.text, '测试语音'); assert.equal(results.vision.length, 2); assert.equal(results.vision[0]?.tags[0]?.tag, '人物'); assert.equal(results.keyframes.length, 2); assert.ok(results.keyframes.every((frame) => frame.status === 'READY')); await Promise.all(results.keyframes.map(async (frame) => assert.equal((await stat(join(root, 'keyframes', run.id, `${frame.shotId}.jpg`))).isFile(), true))); assert.equal((await intelligence.search(project.id, '人物')).length, 2); await intelligence.analyzeRun(run.id); assert.equal((await db.query('select count(*)::int as count from media_analysis_vision_results where run_id=$1', [run.id])).rows[0].count, 2); await db.query('update assets set checksum=$2 where id=$1', [assetId, `sha256:changed-${suffix}`]); await assert.rejects(() => intelligence.analyzeRun(run.id), /MEDIA_ANALYSIS_STALE/); assert.equal((await intelligence.getRun(project.id, run.id))?.status, 'STALE');
  } finally { await db.end(); await rm(root, { recursive: true, force: true }); }
});
