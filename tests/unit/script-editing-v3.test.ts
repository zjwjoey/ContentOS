import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVisualQueriesV3, rankMaterialCandidateV3 } from '../../packages/modules/video/src/index.js';
import { validateEditManifest, type EditManifestV0 } from '../../packages/contracts/src/index.js';

test('V3 visual queries are reproducible and bounded', () => {
  const queries = buildVisualQueriesV3('越来越多消费者走进低价门店');
  assert.ok(queries.length >= 3 && queries.length <= 5);
  assert.deepEqual(queries, buildVisualQueriesV3('越来越多消费者走进低价门店'));
});

test('V3 candidate range preserves sentence duration', () => {
  const candidate = rankMaterialCandidateV3({ text: '货架 商品 特写', durationMs: 3_200 }, { assetId: 'asset-1', sourcePath: 'F:/media/a.mp4', fileName: '货架商品.mp4', durationMs: 10_000, width: 1920, height: 1080, tags: ['货架', '商品'] });
  assert.equal(candidate.recommendedSourceOutMs - candidate.recommendedSourceInMs, 3_200);
  assert.ok(candidate.finalScore > 0);
});

test('V3 sourceOut is validated against timeline duration', () => {
  const manifest: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', workspaceId: 'workspace-v3', seed: 1, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline: [{ assetId: 'asset-1', sourcePath: 'F:/media/a.mp4', sourceInMs: 800, sourceOutMs: 4_000, durationMs: 3_200, transition: 'cut', sentenceId: 'sentence-0', locked: false, selectionSource: 'AUTO', revision: 1 }], audio: { volume: 1 }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } };
  assert.doesNotThrow(() => validateEditManifest(manifest));
  assert.throws(() => validateEditManifest({ ...manifest, timeline: [{ ...manifest.timeline[0]!, sourceOutMs: 4_001 }] }), /invalid clip timing/);
});
