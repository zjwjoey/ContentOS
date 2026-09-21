import test from 'node:test';
import assert from 'node:assert/strict';
import { detectShotsV1, mergeShortDetectedShots } from '../../packages/modules/video/src/index.js';
import { SCRIPT_EDITING_V3_SCORING_WEIGHTS, type EditOperationV3 } from '../../packages/contracts/src/index.js';

test('V3.4 shot detection rejects invalid media duration before spawning ffmpeg', async () => {
  await assert.rejects(() => detectShotsV1({ sourcePath: 'missing.mp4', durationMs: 0 }), /SHOT_DETECTION_DURATION_INVALID/);
});

test('V3.4 keeps ranking weights centralized for manual and history feedback', () => {
  assert.equal(SCRIPT_EDITING_V3_SCORING_WEIGHTS.manualSelectBonus, 8);
  assert.equal(SCRIPT_EDITING_V3_SCORING_WEIGHTS.recentReusePenalty, 8);
  assert.ok(SCRIPT_EDITING_V3_SCORING_WEIGHTS.goldBonus > 0);
});

test('V3.4 merges short shot segments without changing the outer duration', () => {
  const merged = mergeShortDetectedShots([
    { sourceInMs: 0, sourceOutMs: 2_000, confidence: 1, evidence: {} },
    { sourceInMs: 2_000, sourceOutMs: 2_400, confidence: .8, evidence: {} },
    { sourceInMs: 2_400, sourceOutMs: 5_000, confidence: 1, evidence: {} },
  ], 800);
  assert.deepEqual(merged.map((shot) => [shot.sourceInMs, shot.sourceOutMs]), [[0, 2_400], [2_400, 5_000]]);
});

test('V3.4 exposes remove and reorder as immutable edit operations', () => {
  const remove: EditOperationV3 = { type: 'REMOVE_CLIP', sentenceId: 'sentence-1' };
  const reorder: EditOperationV3 = { type: 'REORDER', sentenceIds: ['sentence-2', 'sentence-1'] };
  assert.equal(remove.type, 'REMOVE_CLIP');
  assert.deepEqual(reorder.sentenceIds, ['sentence-2', 'sentence-1']);
});
