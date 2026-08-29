import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { AssetCatalogService } from '../../packages/modules/asset/src/index.js';
import { VideoQuickEditService } from '../../packages/modules/video/src/index.js';
import type { EditManifestV0 } from '../../packages/contracts/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';

function parentManifest(projectId: string, assetIds: string[]): EditManifestV0 {
  return {
    schemaVersion: 'EDIT_MANIFEST_V0', projectId, seed: 11,
    canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 },
    timeline: assetIds.map((assetId, index) => ({ assetId, sourcePath: `stale/${assetId}.mp4`, sourceInMs: 0, durationMs: 1_000, transition: index === 1 ? 'fade' : 'cut' })),
    audio: { volume: 1 }, output: { format: 'mp4', videoCodec: 'mpeg4', audioCodec: 'aac' },
  };
}

async function setup() {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create(`Quick Edit ${randomUUID()}`);
  const assetIds = ['a', 'b', 'c'].map((suffix) => `asset-quick-${suffix}-${randomUUID()}`);
  for (const [index, assetId] of assetIds.entries()) {
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO', `sha256:quick-${assetId}`, 100, `source/${assetId}.mp4`, 'READY', { durationMs: 2_000 }]);
    await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3)', [project.id, assetId, 'SOURCE']);
    if (index === 2) await db.query('update assets set metadata = $2 where id = $1', [assetId, { durationMs: 2_000 }]);
  }
  const parentId = `manifest-parent-${randomUUID()}`;
  await db.query('insert into edit_manifests (id, project_id, revision, schema_version, manifest, status) values ($1, $2, $3, $4, $5, $6)', [parentId, project.id, 1, 'EDIT_MANIFEST_V0', parentManifest(project.id, assetIds), 'PERSISTED']);
  return { db, project, assetIds, parentId };
}

async function cleanup(context: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await context.db.query('delete from renders where project_id = $1', [context.project.id]);
  await context.db.query('delete from edit_manifests where project_id = $1', [context.project.id]);
  await context.db.query('delete from project_assets where project_id = $1', [context.project.id]);
  await context.db.query('delete from assets where project_id = $1', [context.project.id]);
  await context.db.query('delete from content_projects where id = $1', [context.project.id]);
  await context.db.end();
}

test('Quick Edit persists an immutable vN+1 and supersedes only the current parent', async () => {
  const context = await setup();
  try {
    const service = new VideoQuickEditService(context.db, new AssetCatalogService(context.db));
    const result = await service.createVersion({
      projectId: context.project.id, parentManifestId: context.parentId,
      operations: [{ type: 'TRIM', clipIndex: 1, sourceInMs: 100, durationMs: 500 }, { type: 'REMOVE', clipIndex: 0 }],
      createdBy: 'operator-1', idempotencyKey: `quick-${randomUUID()}`,
    });
    assert.equal(result.revision, 2);
    assert.equal(result.parentManifestId, context.parentId);
    assert.equal(result.status, 'PERSISTED');
    assert.deepEqual(result.editOperations, [{ type: 'TRIM', clipIndex: 1, sourceInMs: 100, durationMs: 500 }, { type: 'REMOVE', clipIndex: 0 }]);
    assert.deepEqual(result.manifest.timeline.map((clip) => clip.assetId), [context.assetIds[1], context.assetIds[2]]);
    assert.equal(result.manifest.timeline[0]?.sourcePath, `source/${context.assetIds[1]}.mp4`);
    const rows = await context.db.query<{ id: string; status: string }>('select id, status from edit_manifests where project_id = $1 order by revision', [context.project.id]);
    assert.deepEqual(rows.rows, [{ id: context.parentId, status: 'SUPERSEDED' }, { id: result.id, status: 'PERSISTED' }]);
  } finally { await cleanup(context); }
});

test('Quick Edit idempotency returns the original version and rejects a digest conflict', async () => {
  const context = await setup();
  try {
    const service = new VideoQuickEditService(context.db, new AssetCatalogService(context.db));
    const idempotencyKey = `quick-idempotent-${randomUUID()}`;
    const input = { projectId: context.project.id, parentManifestId: context.parentId, operations: [{ type: 'REMOVE' as const, clipIndex: 2 }], createdBy: 'operator-1', idempotencyKey };
    const first = await service.createVersion(input);
    const same = await service.createVersion(input);
    assert.equal(same.id, first.id);
    await assert.rejects(() => service.createVersion({ ...input, operations: [{ type: 'TRIM', clipIndex: 0, sourceInMs: 10, durationMs: 100 }] }), /VIDEO_MANIFEST_IDEMPOTENCY_CONFLICT/);
  } finally { await cleanup(context); }
});

test('Quick Edit rejects foreign or non-current parents and unavailable source assets', async () => {
  const context = await setup();
  const other = await new ProjectService(context.db).create(`Foreign ${randomUUID()}`);
  try {
    const service = new VideoQuickEditService(context.db, new AssetCatalogService(context.db));
    const input = { projectId: context.project.id, parentManifestId: context.parentId, operations: [{ type: 'REMOVE' as const, clipIndex: 0 }], createdBy: 'operator-1' };
    await assert.rejects(() => service.createVersion({ ...input, projectId: other.id }), /not found|project|PARENT_NOT_FOUND/i);
    const first = await service.createVersion({ ...input, idempotencyKey: `first-${randomUUID()}` });
    await assert.rejects(() => service.createVersion({ ...input, parentManifestId: context.parentId, idempotencyKey: `stale-${randomUUID()}` }), /current|SUPERSEDED/i);
    await context.db.query('update assets set lifecycle = $2 where id = $1', [context.assetIds[1], 'STAGED']);
    await assert.rejects(() => service.createVersion({ projectId: context.project.id, parentManifestId: first.id, operations: [{ type: 'TRIM', clipIndex: 0, sourceInMs: 0, durationMs: 100 }], createdBy: 'operator-1' }), /source|READY|unavailable/i);
  } finally {
    await context.db.query('delete from content_projects where id = $1', [other.id]);
    await cleanup(context);
  }
});

test('concurrent Quick Edits cannot allocate the same revision', async () => {
  const context = await setup();
  try {
    const service = new VideoQuickEditService(context.db, new AssetCatalogService(context.db));
    const calls = [0, 1].map((index) => service.createVersion({ projectId: context.project.id, parentManifestId: context.parentId, operations: [{ type: 'TRIM', clipIndex: index, sourceInMs: 10, durationMs: 100 }], createdBy: 'operator-1', idempotencyKey: `concurrent-${index}-${randomUUID()}` }));
    const results = await Promise.allSettled(calls);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const revisions = await context.db.query<{ revision: number }>('select revision from edit_manifests where project_id = $1 order by revision', [context.project.id]);
    assert.deepEqual(revisions.rows.map((row) => Number(row.revision)), [1, 2]);
  } finally { await cleanup(context); }
});
