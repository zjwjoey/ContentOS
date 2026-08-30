import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEditManifest, type EditManifestV0 } from '../../packages/contracts/src/index.js';

test('EDIT_MANIFEST_V0 accepts standalone workspace ownership without a project', () => {
  const manifest: EditManifestV0 = {
    schemaVersion: 'EDIT_MANIFEST_V0', workspaceId: 'workspace-standalone', seed: 1,
    canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 },
    timeline: [{ assetId: 'asset-a', sourcePath: 'a.mp4', sourceInMs: 0, durationMs: 2_000, transition: 'cut' }],
    audio: { voiceAssetId: 'voice-1', volume: 1 }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' },
  };
  assert.doesNotThrow(() => validateEditManifest(manifest));
});

test('EDIT_MANIFEST_V0 rejects a manifest with neither project nor workspace ownership', () => {
  assert.throws(() => validateEditManifest({ schemaVersion: 'EDIT_MANIFEST_V0', seed: 1, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline: [{ assetId: 'asset-a', sourcePath: 'a.mp4', sourceInMs: 0, durationMs: 2_000, transition: 'cut' }], audio: { volume: 1 }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } } as never), /project or workspace/i);
});
