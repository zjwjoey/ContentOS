import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAssetImportV0, type AssetImportV0, type AssetSummaryV0 } from '../../packages/contracts/src/index.js';

test('AssetImportV0 accepts bounded lifecycle and safe browser fields', () => {
  const value: AssetImportV0 = { schemaVersion: 'ASSET_IMPORT_V0', id: 'import-1', projectId: 'project-1', originalName: '门店视频.mp4', kind: 'VIDEO', byteSize: 1024, state: 'READY', outputAssetId: 'asset-1', createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:01.000Z' };
  validateAssetImportV0(value);
  const summary: AssetSummaryV0 = { id: 'asset-1', kind: 'VIDEO', lifecycle: 'READY', byteSize: 1024, checksum: 'sha256:' + 'a'.repeat(64), originalName: '门店视频.mp4', metadata: { durationMs: 1000, width: 1080, height: 1920, format: 'mp4' } };
  assert.equal('storageKey' in summary, false);
  assert.equal('sourcePath' in summary, false);
});

test('AssetImportV0 rejects unsafe states, paths and oversized values', () => {
  assert.throws(() => validateAssetImportV0({ schemaVersion: 'ASSET_IMPORT_V0', id: 'import-1', projectId: 'project-1', originalName: '../secret.mp4', kind: 'VIDEO', byteSize: 0, state: 'UNKNOWN' } as never));
  assert.throws(() => validateAssetImportV0({ schemaVersion: 'ASSET_IMPORT_V0', id: 'import-1', projectId: 'project-1', originalName: 'ok.mp4', kind: 'VIDEO', byteSize: Number.MAX_SAFE_INTEGER, state: 'STAGED' } as never));
});
