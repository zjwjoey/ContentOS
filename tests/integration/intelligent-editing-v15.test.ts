import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../packages/database/src/client.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { JobRunner, JobService } from '../../packages/modules/job/src/index.js';
import { MEDIA_ANALYSIS, MediaIntelligenceService, createFakeIntelligenceProviders } from '../../packages/modules/intelligence/src/index.js';
import { createMediaAnalysisJobHandler } from '../../workers/media-intelligence-worker/src/handler.js';

const databaseUrl = process.env.CONTENTOS_INTELLIGENCE_TEST_DATABASE_URL;

test('isolated media intelligence job produces durable analysis results', { skip: !databaseUrl }, async () => {
  const db = await createDatabase(databaseUrl!);
  const suffix = randomUUID();
  try {
    const project = await new ProjectService(db).create(`Intelligence isolated ${suffix}`);
    const assetId = `asset-${suffix}`;
    await db.query('insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [assetId, project.id, 'VIDEO', `sha256:${suffix}`, 100, `objects/${assetId}.mp4`, 'READY', { durationMs: 6_000, width: 720, height: 1_280, tags: ['人物'], transcript: '测试语音' }]);
    await db.query('insert into project_assets(project_id,asset_id,role) values ($1,$2,$3)', [project.id, assetId, 'SOURCE']);
    const intelligence = new MediaIntelligenceService(db, createFakeIntelligenceProviders());
    const jobs = new JobService(db);
    const run = await intelligence.createRun({ projectId: project.id, assetId });
    const job = await jobs.create({ id: `job-${suffix}`, type: MEDIA_ANALYSIS, projectId: project.id, workspaceId: null, payload: { schemaVersion: 'MEDIA_ANALYSIS_JOB_V1', projectId: project.id, assetId, runId: run.id, correlationId: `corr-${suffix}` }, idempotencyKey: `job-key-${suffix}`, maxAttempts: 3 });
    await intelligence.attachJob(run.id, job.id);
    const final = await new JobRunner(jobs, 'test-media-intelligence').run(job.id, createMediaAnalysisJobHandler({ jobs, intelligence }));
    const results = await intelligence.results(project.id, run.id);
    assert.equal(final.state, 'SUCCEEDED');
    assert.equal(results.run.status, 'SUCCEEDED');
    assert.equal(results.shots.length, 2);
    assert.equal(results.asr[0]?.text, '测试语音');
    assert.equal(results.vision[0]?.tags[0]?.tag, '人物');
    assert.equal((await intelligence.search(project.id, '人物')).length, 1);
  } finally { await db.end(); }
});
