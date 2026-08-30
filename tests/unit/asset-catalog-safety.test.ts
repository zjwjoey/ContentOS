import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCatalogService } from '../../packages/modules/asset/src/index.js';

test('workspace asset catalog omits storage keys from browser-facing summaries', async () => {
  const catalog = new AssetCatalogService({
    query: async () => ({ rows: [{ id: 'asset-1', kind: 'VIDEO', lifecycle: 'READY', byte_size: 12, checksum: 'sha256:' + 'a'.repeat(64), storage_key: 'objects/private/key', metadata: { originalName: 'clip.mp4', durationMs: 1000 } }] }),
  } as never);
  const [asset] = await catalog.listWorkspaceAssets('workspace-1');
  assert.equal(asset?.id, 'asset-1');
  assert.equal('storageKey' in (asset || {}), false);
});
