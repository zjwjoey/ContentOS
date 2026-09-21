import test from 'node:test';
import assert from 'node:assert/strict';
import { detectShotsV1 } from '../../packages/modules/video/src/index.js';
import { SCRIPT_EDITING_V3_SCORING_WEIGHTS } from '../../packages/contracts/src/index.js';

test('V3.4 shot detection rejects invalid media duration before spawning ffmpeg', async () => {
  await assert.rejects(() => detectShotsV1({ sourcePath: 'missing.mp4', durationMs: 0 }), /SHOT_DETECTION_DURATION_INVALID/);
});

test('V3.4 keeps ranking weights centralized for manual and history feedback', () => {
  assert.equal(SCRIPT_EDITING_V3_SCORING_WEIGHTS.manualSelectBonus, 8);
  assert.equal(SCRIPT_EDITING_V3_SCORING_WEIGHTS.recentReusePenalty, 8);
  assert.ok(SCRIPT_EDITING_V3_SCORING_WEIGHTS.goldBonus > 0);
});
