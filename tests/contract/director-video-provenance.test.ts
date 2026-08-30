import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEditManifest, type EditManifestV0 } from '../../packages/contracts/src/index.js';
import { buildVideoManifest } from '../../packages/modules/video/src/planner.js';

test('EDIT_MANIFEST_V0 remains valid with optional Director provenance metadata', () => {
  const manifest: EditManifestV0 = buildVideoManifest({ projectId: 'project-provenance', seed: 7, targetDurationMs: 1_000, assets: [{ id: 'asset-1', storageKey: 'ready/asset-1', sourcePath: 'C:/asset-1.mp4', durationMs: 1_000 }], metadata: { briefId: 'brief-1', scriptRevisionId: 'script-revision-1', storyboardRevisionId: 'storyboard-revision-1' } });
  assert.doesNotThrow(() => validateEditManifest(manifest));
  assert.deepEqual(manifest.metadata, { briefId: 'brief-1', scriptRevisionId: 'script-revision-1', storyboardRevisionId: 'storyboard-revision-1' });
});

test('legacy manifests without Director metadata remain valid', () => {
  const manifest: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', projectId: 'legacy-project', seed: 1, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline: [{ assetId: 'asset-1', sourcePath: 'C:/asset-1.mp4', sourceInMs: 0, durationMs: 1_000, transition: 'cut' }], audio: { volume: 1 }, output: { format: 'mp4', videoCodec: 'mpeg4', audioCodec: 'aac' } };
  assert.doesNotThrow(() => validateEditManifest(manifest));
});
