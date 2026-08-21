import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { AssetService } from '../../packages/modules/asset/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

test('Asset import promotes a Unicode local file atomically and deduplicates bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-asset-test-'));
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const source = join(root, '素材-中文.mp4');
  await writeFile(source, Buffer.from('asset-vertical-slice-bytes', 'utf8'));
  await db.query("delete from project_assets where project_id = 'project-asset-test'");
  await db.query("delete from assets where project_id = 'project-asset-test'");
  await db.query("delete from content_projects where id = 'project-asset-test'");
  await db.query("insert into content_projects (id, name, status) values ('project-asset-test', 'Asset Test', 'DRAFT')");
  const storage = new LocalStorageProvider(join(root, 'storage'));
  const assets = new AssetService(db, storage);
  try {
    const first = await assets.importFile({ projectId: 'project-asset-test', sourcePath: source, kind: 'VIDEO' });
    const second = await assets.importFile({ projectId: 'project-asset-test', sourcePath: source, kind: 'VIDEO' });
    assert.equal(first.status, 'READY');
    assert.equal(second.status, 'DEDUPED');
    assert.equal(second.id, first.id);
    assert.match(first.storageKey, /objects/);
    const row = await db.query<{ count: string }>("select count(*)::text as count from assets where project_id = 'project-asset-test'");
    assert.equal(row.rows[0]?.count, '1');
  } finally { await db.end(); await rm(root, { recursive: true, force: true }); }
});

test('Asset reconciliation reports missing blobs and orphan blobs without auto-deleting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-asset-reconcile-'));
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const source = join(root, 'source.mp4');
  await writeFile(source, Buffer.from('reconcile-bytes', 'utf8'));
  await db.query("delete from project_assets where project_id = 'project-reconcile-test'");
  await db.query("delete from assets where project_id = 'project-reconcile-test'");
  await db.query("delete from content_projects where id = 'project-reconcile-test'");
  await db.query("insert into content_projects (id, name, status) values ('project-reconcile-test', 'Reconcile Test', 'DRAFT')");
  const storage = new LocalStorageProvider(join(root, 'storage'));
  const assets = new AssetService(db, storage);
  try {
    const imported = await assets.importFile({ projectId: 'project-reconcile-test', sourcePath: source, kind: 'VIDEO' });
    await rm(join(root, 'storage', imported.storageKey), { force: true });
    await mkdir(join(root, 'storage', 'objects', 'orphan'), { recursive: true });
    await writeFile(join(root, 'storage', 'objects', 'orphan', 'blob.bin'), 'orphan');
    const report = await assets.reconcile('project-reconcile-test');
    assert.equal(report.missingAssets.length, 1);
    assert.equal(report.orphanBlobs.length, 1);
  } finally { await db.end(); await rm(root, { recursive: true, force: true }); }
});
