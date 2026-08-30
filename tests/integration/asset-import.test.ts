import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { AssetImportService } from '../../packages/modules/asset/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';

async function cleanup(db: Awaited<ReturnType<typeof createDatabase>>, projectId: string): Promise<void> {
  await db.query('delete from asset_imports where project_id = $1', [projectId]);
  await db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [projectId]);
  await db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [projectId]);
  await db.query('delete from jobs where project_id = $1', [projectId]);
  await db.query('delete from project_assets where project_id = $1', [projectId]);
  await db.query('delete from assets where project_id = $1', [projectId]);
  await db.query('delete from content_projects where id = $1', [projectId]);
}

test('AssetImportService owns project-scoped staged records and safe transitions', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const project = await new ProjectService(db).create(`Asset import ${randomUUID()}`);
  try {
    const service = new AssetImportService(db);
    const staged = await service.createStaged({ projectId: project.id, originalName: '门店视频.mp4', kind: 'VIDEO', byteSize: 1024, stagedPath: 'staging/import.part', correlationId: 'corr-asset-import' });
    assert.equal(staged.state, 'STAGED'); assert.equal(staged.jobId, null); assert.equal(staged.originalName, '门店视频.mp4');
    await new JobService(db).create({ id: 'job-import-1', projectId: project.id, type: 'ASSET_IMPORT', payload: { schemaVersion: 'ASSET_IMPORT_V0', projectId: project.id, importId: staged.id, correlationId: 'corr-asset-import' }, idempotencyKey: 'asset-import-job-1', maxAttempts: 3 });
    const queued = await service.attachJob(project.id, staged.id, 'job-import-1'); assert.equal(queued.state, 'QUEUED'); assert.equal(queued.jobId, 'job-import-1');
    assert.deepEqual(await service.attachJob(project.id, staged.id, 'job-import-1'), queued);
    assert.equal((await service.list(project.id)).length, 1);
    assert.equal(await service.get('foreign-project', staged.id), null);
    await assert.rejects(() => service.createStaged({ projectId: project.id, originalName: '../secret.mp4', kind: 'VIDEO', byteSize: 10, stagedPath: 'staging/import.part', correlationId: 'corr' }), /originalName/);
  } finally { await cleanup(db, project.id); await db.end(); }
});

test('AssetImportService completion is idempotent and only PROCESSING can terminalize', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const project = await new ProjectService(db).create(`Asset import transition ${randomUUID()}`);
  try {
    const service = new AssetImportService(db);
    const staged = await service.createStaged({ projectId: project.id, originalName: 'voice.wav', kind: 'AUDIO', byteSize: 200, stagedPath: 'staging/voice.part', correlationId: 'corr-transition' });
    await assert.rejects(() => service.complete(project.id, staged.id, { outputAssetId: 'asset-1', state: 'READY' }), /PROCESSING/);
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', ['asset-1', project.id, 'AUDIO', 'sha256:' + 'b'.repeat(64), 200, 'objects/asset-1', 'READY', {}]);
    await new JobService(db).create({ id: 'job-import-2', projectId: project.id, type: 'ASSET_IMPORT', payload: { schemaVersion: 'ASSET_IMPORT_V0', projectId: project.id, importId: staged.id, correlationId: 'corr-transition' }, idempotencyKey: 'asset-import-job-2', maxAttempts: 3 });
    await service.attachJob(project.id, staged.id, 'job-import-2'); await service.markProcessing(project.id, staged.id);
    const completed = await service.complete(project.id, staged.id, { outputAssetId: 'asset-1', state: 'READY' });
    assert.equal(completed.state, 'READY'); assert.equal((await service.complete(project.id, staged.id, { outputAssetId: 'asset-1', state: 'READY' })).outputAssetId, 'asset-1');
    await assert.rejects(() => service.fail(project.id, staged.id, { code: 'PROBE_FAILED', message: 'bad media' }), /terminal/);
  } finally { await cleanup(db, project.id); await db.end(); }
});
