import test from 'node:test';
import assert from 'node:assert/strict';
import { compileEditorialManifest, planEditorialScript, rerollEditorialClip, resolveEditorialPlan } from '../../packages/modules/video/src/index.js';

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
  assert.equal(manifest.textOverlays?.length, 2);
});

test('editorial rules expose deterministic roles, template effects, priority and local reroll', () => {
  const sentences = [
    { index: 0, text: 'MIZAN 开业消息', normalizedText: 'mizan 开业消息', voiceStartMs: 0, voiceEndMs: 8_000 },
    { index: 1, text: '但是数据显示销售额增长 14%', normalizedText: '但是数据显示销售额增长 14%', voiceStartMs: 8_000, voiceEndMs: 16_000 },
    { index: 2, text: '欢迎到店体验', normalizedText: '欢迎到店体验', voiceStartMs: 16_000, voiceEndMs: 20_000 },
    { index: 3, text: '市场会慢慢给出答案', normalizedText: '市场会慢慢给出答案', voiceStartMs: 20_000, voiceEndMs: 25_000 },
  ];
  const normal = planEditorialScript({ sentences, template: 'COMMERCIAL_OPINION', knownEntities: ['MIZAN'] });
  const fast = planEditorialScript({ sentences, template: 'STORE_PROMOTION', pace: 'FAST', shotDensity: 'HIGH', knownEntities: ['MIZAN'] });
  assert.deepEqual(normal.scenes.map((scene) => scene.role), ['HOOK', 'TURN', 'CTA', 'ENDING']);
  assert.ok(fast.scenes.some((scene) => scene.clipCount >= normal.scenes.find((candidate) => candidate.sceneIndex === scene.sceneIndex)!.clipCount));
  const assets = Array.from({ length: 10 }, (_, index) => ({ id: `asset-${index}`, path: `asset-${index}.mp4`, durationMs: 10_000, source: 'LOCAL' as const, keywords: index === 0 ? ['mizan'] : [] }));
  const resolved = resolveEditorialPlan(normal, assets, 2, { priorityAssets: [{ assetId: 'asset-9', mode: 'MUST_USE' }], allowControlledReuse: true });
  assert.ok(resolved.scenes.flatMap((scene) => scene.clipSlots).some((slot) => slot.selectedAssetId === 'asset-9'));
  const target = resolved.scenes[0]!.clipSlots[0]!; const rerolled = rerollEditorialClip(resolved, assets, target.id); assert.notEqual(rerolled.scenes[0]!.clipSlots[0]!.selectedAssetId, target.selectedAssetId);
  const manifest = compileEditorialManifest(rerolled, { workspaceId: 'w', seed: 2, planId: 'p', revision: 1 });
  assert.deepEqual(manifest.timeline.map((clip) => clip.assetId), rerolled.scenes.flatMap((scene) => scene.clipSlots.map((slot) => slot.selectedAssetId)));
  assert.equal(manifest.metadata?.editorialPlanId, 'p');
});

test('editorial resolver treats duplicate file paths as one material', () => {
  const plan = planEditorialScript({ sentences: [
    { index: 0, text: '开头', normalizedText: '开头', voiceStartMs: 0, voiceEndMs: 4_000 },
    { index: 1, text: '正文', normalizedText: '正文', voiceStartMs: 4_000, voiceEndMs: 8_000 },
  ], shotDensity: 'HIGH' });
  const resolved = resolveEditorialPlan(plan, [
    { id: 'same-a', path: '素材/同一文件.mp4', durationMs: 10_000, source: 'LOCAL' },
    { id: 'same-b', path: '素材/同一文件.mp4', durationMs: 10_000, source: 'LOCAL' },
    { id: 'other', path: '素材/另一个文件.mp4', durationMs: 10_000, source: 'LOCAL' },
    { id: 'other-2', path: '素材/第三个文件.mp4', durationMs: 10_000, source: 'LOCAL' },
    { id: 'other-3', path: '素材/第四个文件.mp4', durationMs: 10_000, source: 'LOCAL' },
    { id: 'other-4', path: '素材/第五个文件.mp4', durationMs: 10_000, source: 'LOCAL' },
  ], 1, { strictUnique: true });
  const selected = resolved.scenes.flatMap((scene) => scene.clipSlots.map((slot) => slot.asset?.path));
  assert.equal(new Set(selected).size, selected.length);
});
