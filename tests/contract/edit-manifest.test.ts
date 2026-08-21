import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEditManifest, type EditManifestV0 } from '../../packages/contracts/src/index.js';

test('EDIT_MANIFEST_V0 contract rejects adjacent duplicate clips and invalid canvas', () => {
  const manifest: EditManifestV0 = {
    schemaVersion: 'EDIT_MANIFEST_V0', projectId: 'project-contract', seed: 1,
    canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 },
    timeline: [
      { assetId: 'a', sourcePath: 'a.mp4', sourceInMs: 0, durationMs: 500, transition: 'cut' },
      { assetId: 'a', sourcePath: 'a.mp4', sourceInMs: 500, durationMs: 500, transition: 'fade' },
    ],
    audio: { volume: 1 }, output: { format: 'mp4', videoCodec: 'mpeg4', audioCodec: 'aac' },
  };
  assert.throws(() => validateEditManifest(manifest), /Adjacent duplicate/);
  assert.throws(() => validateEditManifest({ ...manifest, timeline: [{ ...manifest.timeline[0]!, assetId: 'b' }], canvas: { ...manifest.canvas, width: 720 } } as unknown as EditManifestV0), /canvas/);
});
