import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRandomMontageManifest, buildVideoManifest, validateEditManifest, type PlannerAsset } from '../../packages/modules/video/src/index.js';

const assets: PlannerAsset[] = [
  { id: 'asset-a', storageKey: 'objects/aa/a.mp4', sourcePath: 'a.mp4', durationMs: 2200 },
  { id: 'asset-b', storageKey: 'objects/bb/b.mp4', sourcePath: 'b.mp4', durationMs: 1800 },
  { id: 'asset-c', storageKey: 'objects/cc/c.mp4', sourcePath: 'c.mp4', durationMs: 2600 },
];

test('video planner emits deterministic EDIT_MANIFEST_V0 with safe timeline', () => {
  const first = buildVideoManifest({ projectId: 'project-video-test', seed: 42, assets, targetDurationMs: 4800, voiceAssetId: 'voice-1', subtitleText: '你好 ContentOS' });
  const second = buildVideoManifest({ projectId: 'project-video-test', seed: 42, assets, targetDurationMs: 4800, voiceAssetId: 'voice-1', subtitleText: '你好 ContentOS' });
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 'EDIT_MANIFEST_V0');
  assert.equal(first.canvas.aspectRatio, '9:16');
  assert.equal(first.timeline.reduce((sum, clip) => sum + clip.durationMs, 0), 4800);
  assert.equal(first.timeline.some((clip, index) => index > 0 && clip.assetId === first.timeline[index - 1]?.assetId), false);
  assert.equal(first.audio.voiceAssetId, 'voice-1');
  assert.equal(first.subtitles?.[0]?.text, '你好 ContentOS');
  assert.doesNotThrow(() => validateEditManifest(first));
});

test('video planner rejects an empty source set', () => {
  assert.throws(() => buildVideoManifest({ projectId: 'project-empty', seed: 1, assets: [], targetDurationMs: 1000 }), /at least one video asset/);
});

test('Random Montage Planner V2 uses deterministic 2-5 second clips and exact voice duration', () => {
  const first = buildRandomMontageManifest({ workspaceId: 'workspace-standalone', seed: 42, assets: assets.map((asset) => ({ ...asset, durationMs: 8_000 })), targetDurationMs: 30_000, voiceAssetId: 'voice-1' });
  const second = buildRandomMontageManifest({ workspaceId: 'workspace-standalone', seed: 42, assets: assets.map((asset) => ({ ...asset, durationMs: 8_000 })), targetDurationMs: 30_000, voiceAssetId: 'voice-1' });
  assert.deepEqual(first, second);
  assert.equal(first.timeline.reduce((sum, clip) => sum + clip.durationMs, 0), 30_000);
  assert.equal(first.projectId, undefined);
  assert.equal(first.workspaceId, 'workspace-standalone');
  assert.equal(first.timeline.slice(0, -1).every((clip) => clip.durationMs >= 2_000 && clip.durationMs <= 5_000), true);
  assert.equal(first.timeline.every((clip) => clip.sourceInMs + clip.durationMs <= 8_000), true);
});
