import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReorderIndexes, buildReplaceOperation } from '../../apps/web/components/video/clip-inspector.js';

test('ClipInspector builds a complete adjacent reorder permutation', () => {
  assert.deepEqual(buildReorderIndexes(2, 4), [0, 2, 1, 3]);
});

test('ClipInspector builds a replacement operation for the selected asset', () => {
  assert.deepEqual(buildReplaceOperation(1, 'ready-video-2'), { type: 'REPLACE', clipIndex: 1, assetId: 'ready-video-2' });
});

test('Manifest revision helper distinguishes current and historical revisions', async () => {
  const { isCurrentManifest } = await import('../../apps/web/components/video/manifest-revision-picker.js');
  assert.equal(isCurrentManifest('manifest-v3', 'manifest-v3'), true);
  assert.equal(isCurrentManifest('manifest-v1', 'manifest-v3'), false);
});
