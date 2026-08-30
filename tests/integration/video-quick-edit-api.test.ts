import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:5432/contentos_test';

test('Video Quick Edit API lists versions, creates an edit and queues exact Manifest render', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-video-quick-edit-api-'));
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create(`Quick Edit API ${randomUUID()}`);
  const foreign = await new ProjectService(db).create(`Quick Edit API foreign ${randomUUID()}`);
  const assetIds = [0, 1, 2].map((index) => `asset-api-quick-${index}-${randomUUID()}`);
  const parentId = `manifest-api-parent-${randomUUID()}`;
  const manifest = {
    schemaVersion: 'EDIT_MANIFEST_V0', projectId: project.id, seed: 4,
    canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 },
    timeline: assetIds.map((assetId, index) => ({ assetId, sourcePath: `stale/${assetId}`, sourceInMs: 0, durationMs: 1_000, transition: index === 1 ? 'fade' : 'cut' })),
    audio: { volume: 1 }, output: { format: 'mp4', videoCodec: 'mpeg4', audioCodec: 'aac' },
  };
  const app = await buildApi({ db, storage: new LocalStorageProvider(join(root, 'storage')) });
  try {
    for (const assetId of assetIds) {
      await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO', `sha256:${assetId}`, 100, `source/${assetId}.mp4`, 'READY', { durationMs: 2_000 }]);
      await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3)', [project.id, assetId, 'SOURCE']);
    }
    await db.query('insert into edit_manifests (id, project_id, revision, schema_version, manifest, status) values ($1, $2, $3, $4, $5, $6)', [parentId, project.id, 1, 'EDIT_MANIFEST_V0', manifest, 'PERSISTED']);
    const list = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/video/manifests` });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items[0].id, parentId);
    assert.equal('sourcePath' in list.json().items[0].manifest.timeline[0], false);

    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/video/quick-edits`, payload: { parentManifestId: parentId, operations: [{ type: 'TRIM', clipIndex: 1, sourceInMs: 100, durationMs: 500 }, { type: 'REMOVE', clipIndex: 0 }], createdBy: 'operator-api', idempotencyKey: `api-${randomUUID()}` } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().revision, 2);
    assert.equal(created.json().manifest.timeline[0].assetId, assetIds[1]);
    assert.equal('sourcePath' in created.json().manifest.timeline[0], false);

    const exact = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/video/manifests/${created.json().id}/render`, payload: {} });
    assert.equal(exact.statusCode, 201, exact.body);
    assert.equal(exact.json().type, 'VIDEO_RENDER');
    assert.equal('payload' in exact.json(), false);
    assert.equal('leaseOwner' in exact.json(), false);
    assert.equal('error' in exact.json(), false);

    const foreignRender = await app.inject({ method: 'POST', url: `/api/v1/projects/${foreign.id}/video/manifests/${created.json().id}/render`, payload: {} });
    assert.equal(foreignRender.statusCode, 404);
    const missing = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/video/manifests/missing/render`, payload: {} });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
    await db.query('delete from renders where project_id = $1', [project.id]);
    await db.query('delete from jobs where project_id = $1', [project.id]);
    await db.query('delete from edit_manifests where project_id = $1', [project.id]);
    await db.query('delete from project_assets where project_id = $1', [project.id]);
    await db.query('delete from assets where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id in ($1, $2)', [project.id, foreign.id]);
    await db.end(); await rm(root, { recursive: true, force: true });
  }
});
