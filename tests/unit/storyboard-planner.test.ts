import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStoryboardVideoManifest } from '../../packages/modules/video/src/index.js';

const assets = [
  { id: 'asset-a', storageKey: 'a.mp4', sourcePath: 'a.mp4', durationMs: 4_000, originalName: '门店环境.mp4', tags: ['门店', '环境'] },
  { id: 'asset-b', storageKey: 'b.mp4', sourcePath: 'b.mp4', durationMs: 4_000, originalName: '数据图表.mp4', tags: ['数据', '图表'] },
];
const scenes = [{ sceneIndex: 1, assetKeywords: ['门店'], durationHintSeconds: 2 }, { sceneIndex: 2, assetKeywords: ['数据'], durationHintSeconds: 2 }];

test('Storyboard planner deterministically matches tagged assets and records scores', () => {
  const first = buildStoryboardVideoManifest({ projectId: 'project-1', seed: 7, storyboardRevisionId: 'storyboard-1', scenes, assets });
  const second = buildStoryboardVideoManifest({ projectId: 'project-1', seed: 7, storyboardRevisionId: 'storyboard-1', scenes, assets });
  assert.deepEqual(first, second);
  assert.deepEqual(first.manifest.timeline.map((clip) => clip.assetId), ['asset-a', 'asset-b']);
  assert.equal(first.decisions[0]?.score, 100);
  assert.equal(first.decisions[1]?.fallback, false);
});

test('Storyboard planner falls back deterministically when keywords do not match', () => {
  const result = buildStoryboardVideoManifest({ projectId: 'project-1', seed: 2, storyboardRevisionId: 'storyboard-1', scenes: [{ sceneIndex: 1, assetKeywords: ['不存在'], durationHintSeconds: 2 }], assets });
  assert.equal(result.decisions[0]?.fallback, true);
  assert.equal(result.decisions[0]?.score, 0);
  assert.equal(result.manifest.timeline[0]?.assetId, 'asset-a');
});
