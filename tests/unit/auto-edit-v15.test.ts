import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildScriptMontageManifest, buildRandomSentenceMontageManifest, assembleBrandedTimeline } from '../../packages/modules/video/src/index.js';
import { applyQuickEditOperations } from '../../packages/modules/video/src/quick-edit.js';
import { generateFixtureAudio, generateFixtureVideo, probeMedia, renderEditManifest } from '../../packages/infrastructure/ffmpeg/src/index.js';

type TestAsset = { id: string; storageKey: string; sourcePath: string; durationMs: number; originalName: string; tags: string[]; usageCount: number; recentUsageCount: number };
const assets: TestAsset[] = [
  { id: 'short-store', storageKey: 'short-store.mp4', sourcePath: 'short-store.mp4', durationMs: 3_000, originalName: '门店短.mp4', tags: ['门店'], usageCount: 20, recentUsageCount: 5 },
  { id: 'long-store', storageKey: 'long-store.mp4', sourcePath: 'long-store.mp4', durationMs: 8_000, originalName: '门店长.mp4', tags: ['门店'], usageCount: 1, recentUsageCount: 0 },
];
const longAsset = assets[1]!;

test('V1.5 planner never truncates voice timing and prefers long eligible media', () => {
  const result = buildScriptMontageManifest({ projectId: 'project-v15', seed: 7, sentences: [{ index: 0, text: '门店口播', normalizedText: '门店口播', voiceStartMs: 0, voiceEndMs: 4_000 }], assets, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 });
  assert.equal(result.manifest.timeline[0]?.assetId, 'long-store');
  assert.equal(result.manifest.timeline[0]?.durationMs, 4_000);
  assert.equal(result.manifest.metadata?.sentences?.[0]?.voiceEndMs, 4_000);
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
