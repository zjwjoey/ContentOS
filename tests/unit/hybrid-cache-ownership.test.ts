import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { AssetService } from '../../packages/modules/asset/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { FakeExternalVideoProvider, HybridMediaService } from '../../packages/modules/video/src/index.js';

test('Hybrid cache reuse preserves canonical Asset metadata and original provenance', async () => {
  const metadata = { durationMs: 6_000, width: 1080, height: 1920, external: { provider: 'fake-pexels', downloadedAt: '2020-01-01T00:00:00.000Z' } };
  const snapshot = structuredClone(metadata);
  let metadataWrites = 0; let associations = 0; let imports = 0;
  const db = { query: async (sql: string) => {
    if (sql.startsWith('select e.asset_id')) return { rows: [{ asset_id: 'asset-cached', storage_key: 'objects/cached.mp4', metadata }] };
    if (sql.startsWith('update assets')) metadataWrites += 1;
    if (sql.startsWith('insert into video_workspace_assets')) associations += 1;
    return { rows: [], rowCount: 0 };
  } } as unknown as Pool;
  const assets = { importFile: async () => { imports += 1; throw new Error('cache reuse must not import'); } } as unknown as AssetService;
  const storage = new LocalStorageProvider('unused-fixture-storage'); storage.exists = async () => true;
  const provider = new FakeExternalVideoProvider();
  const service = new HybridMediaService(assets, storage, provider, db);
  const result = await service.resolve({ workspaceId: 'workspace-1', script: '展示商品。', localAssets: [], usePexels: true });
  assert.equal(result.assets[0]?.id, 'asset-cached');
  assert.equal(metadataWrites, 0); assert.equal(imports, 0); assert.equal(provider.downloadCount, 0);
  assert.ok(associations > 0);
  assert.deepEqual(result.assets[0]?.metadata, snapshot); assert.deepEqual(metadata, snapshot);
});
