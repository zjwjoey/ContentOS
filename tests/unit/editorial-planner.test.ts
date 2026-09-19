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

test('editorial resolver keeps entity truth separate from related place context', () => {
  const plan = planEditorialScript({ sentences: [{ index: 0, text: 'MIZAN正在波兰发展。', normalizedText: 'mizan正在波兰发展', voiceStartMs: 0, voiceEndMs: 6_000 }], knownEntities: ['MIZAN'] });
  const resolved = resolveEditorialPlan(plan, [{ id: 'street', path: 'Poland-street.mp4', durationMs: 8_000, source: 'LOCAL', tags: ['Poland', 'street'] }]);
  const slot = resolved.scenes[0]!.clipSlots[0]!;
  assert.equal(slot.entityRequirement, 'MIZAN');
  assert.equal(slot.entityFallback, true);
  assert.notEqual(slot.asset?.entity, 'MIZAN');
  const manifest = compileEditorialManifest(resolved, { workspaceId: 'w', seed: 1 });
  assert.equal(manifest.timeline[0]?.matching?.selectedRole, 'NEUTRAL_BROLL');
  assert.equal(manifest.timeline[0]?.matching?.entityFallback, true);
});

test('editorial resolver hard-filters short assets for every source and priority mode', () => {
  const plan = planEditorialScript({ sentences: [{ index: 0, text: '重点镜头', normalizedText: '重点镜头', voiceStartMs: 0, voiceEndMs: 6_000 }], pace: 'SLOW', shotDensity: 'LOW' });
  const resolved = resolveEditorialPlan(plan, [
    { id: 'short', path: 'short.mp4', durationMs: 2_000, source: 'LOCAL' },
    { id: 'long', path: 'long.mp4', durationMs: 8_000, source: 'PEXELS' },
  ]);
  assert.equal(resolved.scenes[0]!.clipSlots[0]!.selectedAssetId, 'long');
  assert.throws(() => resolveEditorialPlan(plan, [{ id: 'must-short', path: 'must-short.mp4', durationMs: 2_000, source: 'LOCAL' }], 1, { priorityAssets: [{ assetId: 'must-short', mode: 'MUST_USE' }] }), /EDIT_PRIORITY_ASSET_TOO_SHORT|EDIT_NO_MEDIA_LONG_ENOUGH/);
});

test('editorial manifest preserves voice gaps and shifts intro audio, subtitle and content together', () => {
  const plan = planEditorialScript({ sentences: [
    { index: 0, text: '第一句', normalizedText: '第一句', voiceStartMs: 0, voiceEndMs: 2_000 },
    { index: 1, text: '第二句', normalizedText: '第二句', voiceStartMs: 3_000, voiceEndMs: 5_000 },
  ], heroText: true });
  const resolved = resolveEditorialPlan(plan, [
    { id: 'a', path: 'a.mp4', durationMs: 8_000, source: 'LOCAL' },
    { id: 'b', path: 'b.mp4', durationMs: 8_000, source: 'LOCAL' },
  ]);
  const manifest = compileEditorialManifest(resolved, { workspaceId: 'w', seed: 1, voicePath: 'voice.wav', intro: { id: 'intro', path: 'intro.mp4', durationMs: 1_500, source: 'LOCAL' } });
  assert.equal(manifest.metadata?.audioOffsetMs, 1_500);
  assert.equal(manifest.timeline.find((clip) => clip.role === 'INTRO')?.timelineStartMs, 0);
  const content = manifest.timeline.filter((clip) => clip.role === 'CONTENT');
  assert.equal(content.find((clip) => clip.sentenceIndex === 0)?.timelineStartMs, 1_500);
  assert.equal(content.find((clip) => clip.sentenceIndex === 1)?.timelineStartMs, 4_500);
  assert.equal(manifest.subtitles?.[1]?.startMs, 4_500);
  assert.equal(manifest.metadata?.sentences?.[0]?.voiceStartMs, 1_500);
});

test('editorial reroll reuses full entity and duration resolver constraints', () => {
  const plan = planEditorialScript({ sentences: [{ index: 0, text: 'MIZAN门店', normalizedText: 'mizan门店', voiceStartMs: 0, voiceEndMs: 6_000 }], knownEntities: ['MIZAN'] });
  const assets = [
    { id: 'a', path: 'a.mp4', durationMs: 8_000, source: 'LOCAL' as const, entity: 'MIZAN' },
    { id: 'b', path: 'b.mp4', durationMs: 8_000, source: 'LOCAL' as const, entity: 'MIZAN' },
    { id: 'c', path: 'c.mp4', durationMs: 2_000, source: 'LOCAL' as const, tags: ['Poland'] },
  ];
  const resolved = resolveEditorialPlan(plan, assets, 1);
  const current = resolved.scenes[0]!.clipSlots[0]!.selectedAssetId;
  const rerolled = rerollEditorialClip(resolved, assets, resolved.scenes[0]!.clipSlots[0]!.id, { localOnly: true });
  const slot = rerolled.scenes[0]!.clipSlots[0]!;
  assert.notEqual(slot.selectedAssetId, current);
  assert.ok(slot.selectedAssetId === 'a' || slot.selectedAssetId === 'b');
  assert.equal(slot.entityFallback, false);
  assert.ok((slot.asset?.durationMs || 0) >= slot.durationMs);
});
