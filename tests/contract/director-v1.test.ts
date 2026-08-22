import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateContentBriefV1,
  validateScriptRevisionV1,
  validateStoryboardRevisionV1,
  type ContentBriefV1,
  type ScriptRevisionV1,
  type StoryboardRevisionV1,
} from '../../packages/contracts/src/index.js';

const validBrief: ContentBriefV1 = {
  schemaVersion: 'CONTENT_BRIEF_V1',
  id: 'brief-1', projectId: 'project-1', revision: 1,
  topic: '门店经营中的一个常见误区', targetPlatform: 'douyin',
  channelPositioning: '面向小微商家的经营知识栏目', targetDurationSeconds: 45,
  contentType: 'knowledge', audience: '小微商家经营者',
  coreThesis: '先验证需求，再扩大投入。', tone: '清晰、克制、实用',
  ctaGoal: '引导观众收藏', referenceMaterial: '用户提供的访谈笔记',
  mustInclude: ['一个反例'], mustAvoid: ['夸大承诺'], requirements: {},
  createdBy: 'user-1', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z',
};

const validScript: ScriptRevisionV1 = {
  schemaVersion: 'SCRIPT_REVISION_V1', id: 'script-1', projectId: 'project-1', briefId: 'brief-1',
  revision: 1, origin: 'AI', status: 'DRAFT', title: '不要急着扩大投入',
  titleCandidates: ['不要急着扩大投入', '先验证，再增长'], coverText: '先验证，再增长',
  topicKeywords: ['经营', '验证需求'], hook: '很多人第一步就做错了。',
  body: '先用小成本验证真实需求，再决定是否扩大投入。', cta: '收藏这条建议。',
  createdBy: 'director-worker', createdAt: '2026-08-22T00:00:00.000Z',
};

const validStoryboard: StoryboardRevisionV1 = {
  schemaVersion: 'STORYBOARD_REVISION_V1', id: 'storyboard-1', projectId: 'project-1',
  scriptRevisionId: 'script-1', revision: 1, origin: 'AI', status: 'DRAFT',
  scenes: [
    { sceneIndex: 1, voiceoverText: '很多人第一步就做错了。', durationHintSeconds: 3, visualInstruction: '人物面对账本犹豫', assetKeywords: ['账本'] },
    { sceneIndex: 2, voiceoverText: '先验证真实需求，再扩大投入。', durationHintSeconds: 5, visualInstruction: '展示小规模测试', assetKeywords: ['测试', '门店'] },
  ], createdBy: 'director-worker', createdAt: '2026-08-22T00:00:00.000Z',
};

test('ContentBriefV1 accepts Chinese professional brief fields and bounded duration', () => {
  assert.doesNotThrow(() => validateContentBriefV1(validBrief));
  assert.equal(validBrief.targetPlatform, 'douyin');
});

test('ContentBriefV1 rejects empty thesis and out-of-range duration', () => {
  assert.throws(() => validateContentBriefV1({ ...validBrief, coreThesis: '' }), /coreThesis/);
  assert.throws(() => validateContentBriefV1({ ...validBrief, targetDurationSeconds: 0 }), /targetDurationSeconds/);
  assert.throws(() => validateContentBriefV1({ ...validBrief, targetDurationSeconds: 601 }), /targetDurationSeconds/);
});

test('ScriptRevisionV1 validates origin, status, parent linkage and professional metadata', () => {
  assert.doesNotThrow(() => validateScriptRevisionV1(validScript));
  assert.doesNotThrow(() => validateScriptRevisionV1({ ...validScript, revision: 2, parentRevisionId: 'script-1', origin: 'MANUAL' }));
  assert.throws(() => validateScriptRevisionV1({ ...validScript, titleCandidates: [] }), /titleCandidates/);
  assert.throws(() => validateScriptRevisionV1({ ...validScript, revision: 0 }), /revision/);
});

test('StoryboardRevisionV1 requires a bound script and rejects duplicate or non-positive scenes', () => {
  assert.doesNotThrow(() => validateStoryboardRevisionV1(validStoryboard));
  assert.throws(() => validateStoryboardRevisionV1({ ...validStoryboard, scriptRevisionId: '' }), /scriptRevisionId/);
  assert.throws(() => validateStoryboardRevisionV1({ ...validStoryboard, scenes: [{ ...validStoryboard.scenes[0]!, sceneIndex: 0 }] }), /sceneIndex/);
  assert.throws(() => validateStoryboardRevisionV1({ ...validStoryboard, scenes: [validStoryboard.scenes[0]!, { ...validStoryboard.scenes[1]!, sceneIndex: 1 }] }), /duplicate sceneIndex/);
  assert.throws(() => validateStoryboardRevisionV1({ ...validStoryboard, scenes: [] }), /scenes/);
});
