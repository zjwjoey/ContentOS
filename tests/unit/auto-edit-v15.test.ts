import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildScriptMontageManifest, buildRandomSentenceMontageManifest, assembleBrandedTimeline } from '../../packages/modules/video/src/index.js';
import { applyQuickEditOperations, rankAdjustmentAssets } from '../../packages/modules/video/src/quick-edit.js';
import { generateFixtureAudio, generateFixtureVideo, probeMedia, renderEditManifest } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { describePreset } from '../../apps/web/components/video/preset-description.js';
import { mergeNewMediaSelections, reconcileMediaSelections } from '../../apps/web/components/video/media-selection.js';

type TestAsset = { id: string; storageKey: string; sourcePath: string; durationMs: number; originalName: string; tags: string[]; usageCount: number; recentUsageCount: number };
const assets: TestAsset[] = [
  { id: 'short-store', storageKey: 'short-store.mp4', sourcePath: 'short-store.mp4', durationMs: 3_000, originalName: '门店短.mp4', tags: ['门店'], usageCount: 20, recentUsageCount: 5 },
  { id: 'long-store', storageKey: 'long-store.mp4', sourcePath: 'long-store.mp4', durationMs: 8_000, originalName: '门店长.mp4', tags: ['门店'], usageCount: 1, recentUsageCount: 0 },
];
const longAsset = assets[1]!;

test('preset description only names enabled user-facing options', () => {
  assert.equal(describePreset({ editModeDefault: 'SCRIPT', minClipDurationMs: 2_000, maxClipDurationMs: 5_000, preferUnusedMedia: true, introAssetId: null, outroAssetId: null }), '按脚本剪辑 · 2–5秒 · 优先少重复');
  assert.equal(describePreset({ editModeDefault: 'RANDOM', minClipDurationMs: 2_000, maxClipDurationMs: 5_000, preferUnusedMedia: false, introAssetId: 'global-intro', outroAssetId: 'global-outro' }), '随机混剪 · 2–5秒 · 固定片头 · 固定片尾');
});

test('media selection keeps explicit deselections while adding only newly discovered files', () => {
  assert.deepEqual(mergeNewMediaSelections(['project-a', 'project-c'], ['local-1', 'local-2'], []), ['project-a', 'project-c', 'local-1', 'local-2']);
  assert.deepEqual(mergeNewMediaSelections(['local-1'], ['local-1', 'local-2', 'local-3'], ['local-1', 'local-2']), ['local-1', 'local-3']);
});

test('media selection reconciliation preserves deselections and removes deleted local files', () => {
  assert.deepEqual(reconcileMediaSelections({ selectedIds: ['L1', 'L3'], previousKnownIds: ['L1', 'L2', 'L3', 'L4'], currentAvailableIds: ['L1', 'L2', 'L3', 'L4', 'L5'] }), { selectedIds: ['L1', 'L3', 'L5'], knownIds: ['L1', 'L2', 'L3', 'L4', 'L5'] });
  assert.deepEqual(reconcileMediaSelections({ selectedIds: ['L1', 'L3'], previousKnownIds: ['L1', 'L2', 'L3', 'L4'], currentAvailableIds: ['L1', 'L2', 'L4', 'L5'] }), { selectedIds: ['L1', 'L5'], knownIds: ['L1', 'L2', 'L4', 'L5'] });
});

test('V1.5 planner never truncates voice timing and prefers long eligible media', () => {
  const result = buildScriptMontageManifest({ projectId: 'project-v15', seed: 7, sentences: [{ index: 0, text: '门店口播', normalizedText: '门店口播', voiceStartMs: 0, voiceEndMs: 4_000 }], assets, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 });
  assert.equal(result.manifest.timeline[0]?.assetId, 'long-store');
  assert.equal(result.manifest.timeline[0]?.durationMs, 4_000);
  assert.equal(result.manifest.metadata?.sentences?.[0]?.voiceEndMs, 4_000);
});

test('SCRIPT usage ranking prefers low usage when matches tie, but not over a strong match', () => {
  const tied = buildScriptMontageManifest({ projectId: 'project-v15', seed: 1, sentences: [{ index: 0, text: '门店', normalizedText: '门店' }], assets: [{ ...longAsset, id: 'high-usage', usageCount: 20 }, { ...longAsset, id: 'low-usage', usageCount: 0 }], minClipDurationMs: 1_000, maxClipDurationMs: 1_000 });
  assert.equal(tied.manifest.timeline[0]?.assetId, 'low-usage');
  const strongMatch = buildScriptMontageManifest({ projectId: 'project-v15', seed: 1, sentences: [{ index: 0, text: '门店', normalizedText: '门店' }], assets: [{ ...longAsset, id: 'strong-match', originalName: '门店素材', tags: ['门店'], usageCount: 20 }, { ...longAsset, id: 'weak-match', originalName: '风景素材', tags: ['风景'], usageCount: 0 }], minClipDurationMs: 1_000, maxClipDurationMs: 1_000 });
  assert.equal(strongMatch.manifest.timeline[0]?.assetId, 'strong-match');
});

test('preferUnusedMedia false disables historical penalty while keeping deterministic matching', () => {
  const assetsForPreference = [{ ...longAsset, id: 'a-used', usageCount: 50 }, { ...longAsset, id: 'z-fresh', usageCount: 0 }];
  const enabled = buildScriptMontageManifest({ projectId: 'project-v15', seed: 1, sentences: [{ index: 0, text: '门店', normalizedText: '门店' }], assets: assetsForPreference, preferUnusedMedia: true, minClipDurationMs: 1_000, maxClipDurationMs: 1_000 });
  const disabled = buildScriptMontageManifest({ projectId: 'project-v15', seed: 1, sentences: [{ index: 0, text: '门店', normalizedText: '门店' }], assets: assetsForPreference, preferUnusedMedia: false, minClipDurationMs: 1_000, maxClipDurationMs: 1_000 });
  assert.equal(enabled.manifest.timeline[0]?.assetId, 'z-fresh');
  assert.equal(disabled.manifest.timeline[0]?.assetId, 'a-used');
  assert.equal(enabled.manifest.metadata?.preferUnusedMedia, true);
  assert.equal(disabled.manifest.metadata?.preferUnusedMedia, false);
});

test('REMATCH ranking uses the same match-first, usage-second rule', () => {
  const ranked = rankAdjustmentAssets('门店', [{ ...longAsset, id: 'used-strong', originalName: '门店素材', tags: ['门店'], usageCount: 20 }, { ...longAsset, id: 'fresh-strong', originalName: '门店素材2', tags: ['门店'], usageCount: 0 }, { ...longAsset, id: 'fresh-weak', originalName: '风景素材', tags: ['风景'], usageCount: 0 }]);
  assert.equal(ranked[0]?.asset.id, 'fresh-strong');
  assert.equal(ranked.at(-1)?.asset.id, 'fresh-weak');
});

test('V1.5 visual timeline covers a voice gap without changing sentence voice metadata', () => {
  const result = buildRandomSentenceMontageManifest({ projectId: 'project-v15', seed: 3, sentences: [{ index: 0, text: '第一句', normalizedText: '第一句', voiceStartMs: 0, voiceEndMs: 1_000 }, { index: 1, text: '第二句', normalizedText: '第二句', voiceStartMs: 1_500, voiceEndMs: 2_500 }], assets: [{ ...longAsset, id: 'a' }, { ...longAsset, id: 'b' }], minClipDurationMs: 1_000, maxClipDurationMs: 2_000 });
  assert.equal(result.manifest.timeline[0]?.timelineStartMs, 0);
  assert.equal(result.manifest.timeline[0]?.timelineEndMs, 1_500);
  assert.equal(result.manifest.timeline[1]?.timelineStartMs, 1_500);
  assert.equal(result.manifest.timeline[1]?.timelineEndMs, 2_500);
  assert.deepEqual(result.manifest.metadata?.sentences?.map((sentence) => [sentence.voiceStartMs, sentence.voiceEndMs]), [[0, 1_000], [1_500, 2_500]]);
});

test('V1.5 bulk operations create independent manual replacements', () => {
  const parent = buildRandomSentenceMontageManifest({ projectId: 'project-v15', seed: 1, sentences: [{ index: 0, text: '一句', normalizedText: '一句' }, { index: 1, text: '二句', normalizedText: '二句' }, { index: 2, text: '三句', normalizedText: '三句' }], assets: [{ ...longAsset, id: 'a' }, { ...longAsset, id: 'b' }, { ...longAsset, id: 'c' }], minClipDurationMs: 1_000, maxClipDurationMs: 1_000 }).manifest;
  const next = applyQuickEditOperations(parent, [{ type: 'REROLL', clipIndex: 0, seed: 4 }, { type: 'REROLL', clipIndex: 1, seed: 5 }, { type: 'REROLL', clipIndex: 2, seed: 6 }], [{ ...longAsset, id: 'a' }, { ...longAsset, id: 'b' }, { ...longAsset, id: 'c' }]);
  assert.equal(next.timeline.filter((clip) => clip.reviewStatus === 'MANUAL').length, 3);
  assert.notEqual(next.timeline[0]?.assetId, next.timeline[1]?.assetId);
  assert.notEqual(next.timeline[1]?.assetId, next.timeline[2]?.assetId);
});

test('global branding sources stay out of REMATCH candidates', () => {
  const local = [{ ...longAsset, id: 'local-root:a.mp4', originalName: '门店素材.mp4' }, { ...longAsset, id: 'local-root:b.mp4', originalName: '货架素材.mp4' }];
  const parent = assembleBrandedTimeline(buildRandomSentenceMontageManifest({ projectId: 'project-v15', seed: 1, sentences: [{ index: 0, text: '门店', normalizedText: '门店' }], assets: local, minClipDurationMs: 1_000, maxClipDurationMs: 1_000 }).manifest, { intro: { id: 'global-intro', storageKey: 'global-intro', sourcePath: 'global-intro', durationMs: 1_000, role: 'INTRO' } });
  const next = applyQuickEditOperations(parent, [{ type: 'REMATCH', clipIndex: 1, seed: 4 }], [...local, { ...longAsset, id: 'global-outro', originalName: '品牌片尾.mp4' }], local);
  assert.notEqual(next.timeline[1]?.assetId, 'global-outro');
  assert.equal(next.timeline[0]?.assetId, 'global-intro');
});

test('project-only quick edit candidates ignore historical local media', () => {
  const project = [{ ...longAsset, id: 'project-a', originalName: '项目甲.mp4' }, { ...longAsset, id: 'project-b', originalName: '项目乙.mp4' }, { ...longAsset, id: 'project-c', originalName: '项目丙.mp4' }];
  const historicalLocal = [{ ...longAsset, id: 'local-history:l1.mp4', originalName: '历史本地.mp4' }, { ...longAsset, id: 'local-history:l2.mp4', originalName: '历史本地2.mp4' }];
  const intro = { id: 'global-intro', storageKey: 'global-intro', sourcePath: 'global-intro', durationMs: 1_000, role: 'INTRO' as const };
  const outro = { id: 'global-outro', storageKey: 'global-outro', sourcePath: 'global-outro', durationMs: 1_000, role: 'OUTRO' as const };
  const parent = assembleBrandedTimeline(buildRandomSentenceMontageManifest({ projectId: 'project-v15', seed: 1, sentences: [{ index: 0, text: '项目内容', normalizedText: '项目内容' }], assets: project, minClipDurationMs: 1_000, maxClipDurationMs: 1_000 }).manifest, { intro, outro });
  const sourcePool = [...project, ...historicalLocal, intro, outro];
  const rematched = applyQuickEditOperations(parent, [{ type: 'REMATCH', clipIndex: 1, seed: 4 }], sourcePool, project);
  const rematchedId = rematched.timeline[1]!.assetId;
  assert.ok(project.some((asset) => asset.id === rematchedId));
  assert.equal(rematchedId.startsWith('local-'), false);
  assert.notEqual(rematchedId, intro.id);
  assert.notEqual(rematchedId, outro.id);
  const rerolled = applyQuickEditOperations(parent, [{ type: 'REROLL', clipIndex: 1, seed: 4 }], sourcePool, project);
  assert.ok(project.some((asset) => asset.id === rerolled.timeline[1]!.assetId));
});

test('V1.5 real FFmpeg render delays voice after an intro and preserves output duration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-v15-render-')); const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'; const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
  try {
    const intro = join(root, 'intro.mp4'); const content = join(root, 'content.mp4'); const voice = join(root, 'voice.wav'); const output = join(root, 'output.mp4');
    await generateFixtureVideo(intro, ffmpegPath, 'blue', 2); await generateFixtureVideo(content, ffmpegPath, 'green', 5); await generateFixtureAudio(voice, ffmpegPath);
    const manifest = assembleBrandedTimeline({ schemaVersion: 'EDIT_MANIFEST_V0', projectId: 'project-v15', seed: 1, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline: [{ assetId: 'content', sourcePath: content, sourceInMs: 0, durationMs: 5_000, transition: 'cut', role: 'CONTENT', timelineStartMs: 0, timelineEndMs: 5_000 }], audio: { voicePath: voice, volume: 1 }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } }, { intro: { id: 'intro', storageKey: intro, sourcePath: intro, durationMs: 2_000, role: 'INTRO' } });
    const rendered = await renderEditManifest({ manifest, outputPath: output, ffmpegPath, ffprobePath });
    const probe = await probeMedia(output, ffprobePath);
    assert.ok(rendered.audio); assert.ok(probe.audio); assert.ok(probe.durationMs >= 6_500);
  } finally { await rm(root, { recursive: true, force: true }); }
});
