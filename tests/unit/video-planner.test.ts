import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildRandomMontageManifest,
  buildStoryboardManifest,
  buildVideoManifest,
  validateEditManifest,
  type PlannerAsset,
} from '../../packages/modules/video/src/index.js';

const assets: PlannerAsset[] = [
  { id: 'asset-a', storageKey: 'objects/aa/a.mp4', sourcePath: 'a.mp4', durationMs: 2200 },
  { id: 'asset-b', storageKey: 'objects/bb/b.mp4', sourcePath: 'b.mp4', durationMs: 1800 },
  { id: 'asset-c', storageKey: 'objects/cc/c.mp4', sourcePath: 'c.mp4', durationMs: 2600 },
];

test('video planner emits deterministic EDIT_MANIFEST_V0 with safe timeline', () => {
  const first = buildVideoManifest({
    projectId: 'project-video-test',
    seed: 42,
    assets,
    targetDurationMs: 4800,
    voiceAssetId: 'voice-1',
    subtitleText: '你好 ContentOS',
  });
  const second = buildVideoManifest({
    projectId: 'project-video-test',
    seed: 42,
    assets,
    targetDurationMs: 4800,
    voiceAssetId: 'voice-1',
    subtitleText: '你好 ContentOS',
  });
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 'EDIT_MANIFEST_V0');
  assert.equal(first.canvas.aspectRatio, '9:16');
  assert.equal(
    first.timeline.reduce((sum, clip) => sum + clip.durationMs, 0),
    4800,
  );
  assert.equal(
    first.timeline.some((clip, index) => index > 0 && clip.assetId === first.timeline[index - 1]?.assetId),
    false,
  );
  assert.equal(first.audio.voiceAssetId, 'voice-1');
  assert.equal(first.subtitles?.[0]?.text, '你好 ContentOS');
  assert.doesNotThrow(() => validateEditManifest(first));
});

test('video planner rejects an empty source set', () => {
  assert.throws(() => buildVideoManifest({ projectId: 'project-empty', seed: 1, assets: [], targetDurationMs: 1000 }), /at least one video asset/);
});

test('video planner does not use non-deterministic comparator shuffling', async () => {
  const source = await readFile(new URL('../../packages/modules/video/src/planner.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.sort\(\(\)\s*=>\s*random\(\)\s*-\s*0\.5\)/);
});

test('Random Montage Planner V2 uses deterministic 2-5 second clips and exact voice duration', () => {
  const first = buildRandomMontageManifest({
    workspaceId: 'workspace-standalone',
    seed: 42,
    assets: assets.map((asset) => ({ ...asset, durationMs: 8_000 })),
    targetDurationMs: 30_000,
    voiceAssetId: 'voice-1',
  });
  const second = buildRandomMontageManifest({
    workspaceId: 'workspace-standalone',
    seed: 42,
    assets: assets.map((asset) => ({ ...asset, durationMs: 8_000 })),
    targetDurationMs: 30_000,
    voiceAssetId: 'voice-1',
  });
  assert.deepEqual(first, second);
  assert.equal(
    first.timeline.reduce((sum, clip) => sum + clip.durationMs, 0),
    30_000,
  );
  assert.equal(first.projectId, undefined);
  assert.equal(first.workspaceId, 'workspace-standalone');
  assert.equal(
    first.timeline.slice(0, -1).every((clip) => clip.durationMs >= 2_000 && clip.durationMs <= 5_000),
    true,
  );
  assert.equal(
    first.timeline.every((clip) => clip.sourceInMs + clip.durationMs <= 8_000),
    true,
  );
});

test('Random Montage Planner V2 never schedules beyond a short source asset', () => {
  const manifest = buildRandomMontageManifest({
    workspaceId: 'workspace-short-source',
    seed: 11,
    assets: [
      { id: 'short', storageKey: 'objects/short', sourcePath: 'short.mp4', durationMs: 700 },
      { id: 'long', storageKey: 'objects/long', sourcePath: 'long.mp4', durationMs: 2_500 },
    ],
    targetDurationMs: 4_000,
  });
  assert.equal(
    manifest.timeline.reduce((sum, clip) => sum + clip.durationMs, 0),
    4_000,
  );
  assert.equal(
    manifest.timeline.every((clip) => clip.sourceInMs >= 0 && clip.sourceInMs + clip.durationMs <= (clip.assetId === 'short' ? 700 : 2_500)),
    true,
  );
});

test('Storyboard Planner V1 preserves scene order, provenance, and exact durations', () => {
  const input = {
    projectId: 'project-storyboard',
    seed: 7,
    scenes: [
      { sceneIndex: 1, durationHintSeconds: 4 },
      { sceneIndex: 2, durationHintSeconds: 2.5 },
      { sceneIndex: 3, durationHintSeconds: 6 },
    ],
    sceneAssetBindings: [
      { sceneIndex: 1, assetIds: ['asset-a', 'asset-b'] },
      { sceneIndex: 2, assetIds: ['asset-c'] },
      { sceneIndex: 3, assetIds: ['asset-a', 'asset-c'] },
    ],
    assets: assets.map((asset) => ({ ...asset, durationMs: 8_000 })),
  } as const;
  const first = buildStoryboardManifest(input);
  const second = buildStoryboardManifest(input);
  assert.deepEqual(first, second);
  assert.equal(first.metadata?.plannerMode, 'STORYBOARD_V1');
  assert.deepEqual([...new Set(first.timeline.map((clip) => clip.sceneIndex))], [1, 2, 3]);
  for (const [sceneIndex, duration] of [
    [1, 4_000],
    [2, 2_500],
    [3, 6_000],
  ] as const) {
    assert.equal(
      first.timeline.filter((clip) => clip.sceneIndex === sceneIndex).reduce((sum, clip) => sum + clip.durationMs, 0),
      duration,
    );
  }
  assert.equal(
    first.timeline.reduce((sum, clip) => sum + clip.durationMs, 0),
    12_500,
  );
  assert.doesNotThrow(() => validateEditManifest(first));
});

test('Storyboard Planner V1 rejects missing bindings and insufficient sources without leaking paths', () => {
  const base = {
    projectId: 'project-storyboard-errors',
    seed: 1,
    scenes: [{ sceneIndex: 1, durationHintSeconds: 3 }],
    assets: [{ id: 'asset-a', storageKey: 'objects/aa/a', sourcePath: 'C:/secret/a.mp4', durationMs: 0 }],
  } as const;
  assert.throws(() => buildStoryboardManifest({ ...base, sceneAssetBindings: [] }), /sceneAssetBindings/);
  assert.throws(() => buildStoryboardManifest({ ...base, sceneAssetBindings: [{ sceneIndex: 1, assetIds: ['missing'] }] }), /STORYBOARD_SCENE_ASSET_INVALID/);
  assert.throws(
    () => buildStoryboardManifest({ ...base, sceneAssetBindings: [{ sceneIndex: 1, assetIds: ['asset-a'] }] }),
    /STORYBOARD_SCENE_SOURCE_INSUFFICIENT|duration/i,
  );
  try {
    buildStoryboardManifest({ ...base, sceneAssetBindings: [{ sceneIndex: 1, assetIds: ['asset-a'] }] });
  } catch (error) {
    assert.doesNotMatch(String(error), /C:\\secret/);
  }
});
