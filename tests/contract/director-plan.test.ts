import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDirectorPlan, type DirectorPlanV0 } from '../../packages/contracts/src/index.js';

const validPlan: DirectorPlanV0 = {
  schemaVersion: 'DIRECTOR_PLAN_V0', projectId: 'project-director-contract', seed: 17,
  brief: { topic: '冬季收纳', audience: '小户型家庭', objective: '给出三个可执行建议', tone: '清晰、实用' },
  storyboard: [{ id: 'scene-1', title: '开场', narration: '先整理高频物品', visualIntent: '俯拍收纳盒', durationMs: 2200, sourceAssetIds: ['asset-1'] }],
  provenance: { author: 'zjwjoey', source: 'manual' },
};

test('DIRECTOR_PLAN_V0 accepts a deterministic brief and storyboard', () => {
  assert.doesNotThrow(() => validateDirectorPlan(validPlan));
  assert.equal(validPlan.schemaVersion, 'DIRECTOR_PLAN_V0');
  assert.equal(validPlan.storyboard[0]?.durationMs, 2200);
});

test('DIRECTOR_PLAN_V0 rejects duplicate scene IDs and empty briefs', () => {
  assert.throws(() => validateDirectorPlan({ ...validPlan, brief: { ...validPlan.brief, topic: '' } }), /brief.topic/);
  assert.throws(() => validateDirectorPlan({ ...validPlan, storyboard: [validPlan.storyboard[0]!, { ...validPlan.storyboard[0]!, title: '重复' }] }), /duplicate scene/);
  assert.throws(() => validateDirectorPlan({ ...validPlan, storyboard: [{ ...validPlan.storyboard[0]!, durationMs: 0 }] }), /durationMs/);
});
