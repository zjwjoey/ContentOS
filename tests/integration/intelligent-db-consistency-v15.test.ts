import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createDatabase } from '../../packages/database/src/client.js';
import { generateFixtureVideo } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { MediaIntelligenceService, createFakeIntelligenceProviders, MEDIA_ANALYSIS } from '../../packages/modules/intelligence/src/index.js';
import { createMediaIntelligenceWorker } from '../../workers/media-intelligence-worker/src/main.js';

const databaseUrl = process.env.CONTENTOS_TEST_DATABASE_URL || process.env.DATABASE_URL;

test('API and Media Intelligence Worker consume MEDIA_ANALYSIS from the same DATABASE_URL', { skip: !databaseUrl }, async () => {
  const db = await createDatabase(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), 'contentos-db-consistency-v15-'));
  const storage = new LocalStorageProvider(root);
  const suffix = randomUUID();
  try {
    const source = join(root, 'fixture.mp4');
    await generateFixtureVideo(source, process.env.FFMPEG_PATH || 'ffmpeg', 'blue', 2);
    const storageKey = `objects/${suffix}.mp4`;
    await mkdir(join(root, 'objects'), { recursive: true });
    await copyFile(source, storage.objectPath(storageKey));
    const createdProject = (await db.query<{ id: string }>('insert into content_projects (id,name,status) values ($1,$2,$3) returning id', [`project-${suffix}`, `DB consistency ${suffix}`, 'DRAFT'])).rows[0]!;
    const assetId = `asset-${suffix}`;
    await db.query('insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [assetId, createdProject.id, 'VIDEO', `sha256:${suffix}`, 100, storageKey, 'READY', { durationMs: 2_000, width: 640, height: 360, tags: ['一致性'] }]);
    await db.query('insert into project_assets(project_id,asset_id,role) values ($1,$2,$3)', [createdProject.id, assetId, 'SOURCE']);
    const intelligence = new MediaIntelligenceService(db, createFakeIntelligenceProviders(), { storage, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', keyframeRoot: join(root, 'keyframes') });
    const app = await buildApi({ db, storage, intelligence });
    const response = await app.inject({ method: 'POST', url: `/api/v1/projects/${createdProject.id}/intelligence/analyses`, payload: { assetId } });
    assert.equal(response.statusCode, 202);
    const queued = response.json() as { runId: string; jobId: string };
    assert.ok(queued.jobId);
    const jobs = new JobService(db);
    const worker = createMediaIntelligenceWorker({ jobs, intelligence }, { workerId: `db-consistency-${suffix}`, concurrency: 1 });
    await worker.consume();
    const job = await jobs.get(queued.jobId);
    assert.equal(job?.type, MEDIA_ANALYSIS);
    assert.equal(job?.state, 'SUCCEEDED');
    assert.equal((await intelligence.getRun(createdProject.id, queued.runId))?.status, 'SUCCEEDED');
    await app.close();
  } finally {
    await db.end();
    await rm(root, { recursive: true, force: true });
  }
});
