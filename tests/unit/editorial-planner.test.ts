import test from 'node:test';
import assert from 'node:assert/strict';
import { compileEditorialManifest, planEditorialScript, resolveEditorialPlan } from '../../packages/modules/video/src/index.js';

test('editorial planner classifies roles and conserves voiced duration', () => {
  const sentences = [
    { index: 0, text: 'MIZAN 开业了', normalizedText: 'mizan 开业了', voiceStartMs: 0, voiceEndMs: 4_000 },
    { index: 1, text: '数据显示销售额增长 20%', normalizedText: '数据显示销售额增长 20%', voiceStartMs: 4_000, voiceEndMs: 7_000 },
    { index: 2, text: '欢迎到店体验', normalizedText: '欢迎到店体验', voiceStartMs: 7_000, voiceEndMs: 10_000 },
  ];
  const plan = planEditorialScript({ sentences, pace: 'NORMAL', knownEntities: ['MIZAN'] });
  assert.deepEqual(plan.scenes.map((scene) => scene.role), ['HOOK', 'EVIDENCE', 'ENDING']);
  for (const scene of plan.scenes) assert.equal(scene.clipSlots.reduce((sum, slot) => sum + slot.durationMs, 0), scene.endMs - scene.startMs);
  assert.equal(plan.subtitles.length, 3);
  const resolved = resolveEditorialPlan(plan, [
    { id: 'a', path: 'a.mp4', durationMs: 8_000, source: 'LOCAL' },
    { id: 'b', path: 'b.mp4', durationMs: 8_000, source: 'LOCAL' },
    { id: 'c', path: 'c.mp4', durationMs: 8_000, source: 'PEXELS' },
    { id: 'd', path: 'd.mp4', durationMs: 8_000, source: 'LOCAL' },
    { id: 'e', path: 'e.mp4', durationMs: 8_000, source: 'LOCAL' },
  ]);
  const manifest = compileEditorialManifest(resolved, { workspaceId: 'w', seed: 1, voicePath: 'voice.wav' });
  assert.equal(manifest.timeline.reduce((sum, clip) => sum + clip.durationMs, 0), 10_000);
  assert.equal(manifest.textOverlays?.length, 3);
});
