import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIntelligentManifest, planIntelligentEdit } from '../../packages/modules/intelligence/src/index.js';

test('intelligent planner emits existing EDIT_MANIFEST_V0 with explainable candidate rankings', () => {
  const result = planIntelligentEdit({ id: 'plan-1', projectId: 'project-1', sentences: [{ id: 's1', text: '人物走进门店', durationMs: 2_000 }, { id: 's2', text: '商品特写', durationMs: 2_000 }], assets: [{ id: 'asset-a', sourcePath: 'objects/a.mp4', durationMs: 4_000, summary: '人物走进门店', tags: ['人物'] }, { id: 'asset-b', sourcePath: 'objects/b.mp4', durationMs: 4_000, summary: '商品特写', tags: ['商品'] }], config: { schemaVersion: 'INTELLIGENT_PLANNER_CONFIG_V1', version: 'test-v1', targetDurationMs: 4_000, minClipDurationMs: 1_000, maxClipDurationMs: 3_000, maxAssetReuse: 2, diversityWeight: .8 } });
  assert.equal(result.manifest.schemaVersion, 'EDIT_MANIFEST_V0');
  assert.deepEqual(result.manifest.timeline.map((clip) => clip.assetId), ['asset-a', 'asset-b']);
  assert.ok(result.candidates.some((candidate) => candidate.selected && candidate.reasons.length > 0));
  assert.equal(result.quality.passed, true);
});

test('intelligent planner allows a single asset only with explicit reuse evidence', () => {
  const result = planIntelligentEdit({ id: 'plan-2', projectId: 'project-1', sentences: [{ id: 's1', text: '第一段', durationMs: 1_000 }, { id: 's2', text: '第二段', durationMs: 1_000 }], assets: [{ id: 'asset-a', sourcePath: 'objects/a.mp4', durationMs: 2_000, summary: '素材' }], config: { schemaVersion: 'INTELLIGENT_PLANNER_CONFIG_V1', version: 'test-v1', targetDurationMs: 2_000, minClipDurationMs: 1_000, maxClipDurationMs: 1_000, maxAssetReuse: 1, diversityWeight: .8 } });
  assert.equal(result.manifest.timeline[1]?.matching?.allowAssetReuse, true);
  assert.equal(result.manifest.metadata?.plannerVersion, 'test-v1');
});

test('quality diversity uses real shotType provenance and duration fit uses requested sentence duration', () => {
  const base = planIntelligentEdit({ id: 'quality-plan', projectId: 'project-1', sentences: [{ id: 's1', text: 'wide', durationMs: 1_500 }, { id: 's2', text: 'medium', durationMs: 1_500 }, { id: 's3', text: 'close', durationMs: 1_500 }], shots: [{ id: 'wide-shot', assetId: 'wide-asset', shotId: 'wide-shot', sourcePath: 'wide.mp4', sourceInMs: 0, sourceOutMs: 2_000, durationMs: 2_000, summary: 'wide', shotType: 'wide' }, { id: 'medium-shot', assetId: 'medium-asset', shotId: 'medium-shot', sourcePath: 'medium.mp4', sourceInMs: 0, sourceOutMs: 2_000, durationMs: 2_000, summary: 'medium', shotType: 'medium' }, { id: 'close-shot', assetId: 'close-asset', shotId: 'close-shot', sourcePath: 'close.mp4', sourceInMs: 0, sourceOutMs: 2_000, durationMs: 2_000, summary: 'close', shotType: 'close' }], config: { schemaVersion: 'INTELLIGENT_PLANNER_CONFIG_V1', version: 'quality-v1', targetDurationMs: 4_500, minClipDurationMs: 1_000, maxClipDurationMs: 4_000, maxAssetReuse: 1, diversityWeight: .8 } });
  assert.equal(base.quality.shotTypeDiversity, 1);
  assert.equal(base.quality.durationFit, 1);
  const unknown = structuredClone(base.manifest); unknown.timeline = unknown.timeline.map((clip) => ({ ...clip, matching: { ...clip.matching!, shotType: 'unknown', selectedRole: 'AUTHENTIC_ENTITY' } })); const unknownQuality = evaluateIntelligentManifest(unknown, base.config); assert.equal(unknownQuality.shotTypeDiversity, 0); assert.equal(unknownQuality.evidence?.knownShotTypeCount, 0); assert.equal(unknownQuality.evidence?.unknownShotTypeCount, 3);
});
