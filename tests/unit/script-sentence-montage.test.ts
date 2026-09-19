import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleBrandedTimeline, buildRandomSentenceMontageManifest, buildScriptMontageManifest, segmentScriptSentences, type SentenceMontageAsset } from '../../packages/modules/video/src/index.js';

const assets: SentenceMontageAsset[] = [
  { id: 'store', storageKey: 'store.mp4', sourcePath: 'store.mp4', durationMs: 8_000, originalName: '欧洲门店.mp4', tags: ['门店', '欧洲'] },
  { id: 'chart', storageKey: 'chart.mp4', sourcePath: 'chart.mp4', durationMs: 8_000, originalName: '销售数据.mp4', tags: ['数据', '图表'] },
  { id: 'people', storageKey: 'people.mp4', sourcePath: 'people.mp4', durationMs: 8_000, originalName: '顾客购物.mp4', tags: ['顾客'] },
];

test('sentence segmentation handles mixed punctuation without decimal or URL splits', () => {
  const sentences = segmentScriptSentences('Action今年开了2.5家店。访问 https://example.com/a.b 了解详情！\n\n同样是折扣零售，结果为什么不同？');
  assert.deepEqual(sentences.map((item) => item.text), ['Action今年开了2.5家店。', '访问 https://example.com/a.b 了解详情！', '同样是折扣零售，结果为什么不同？']);
});

test('random sentence montage emits exactly one clip per sentence and is reproducible', () => {
  const sentences = segmentScriptSentences('第一句。第二句。第三句。第四句。');
  const pool = [...assets, { ...assets[0]!, id: 'extra' }];
  const first = buildRandomSentenceMontageManifest({ projectId: 'p', seed: 8, sentences, assets: pool });
  const second = buildRandomSentenceMontageManifest({ projectId: 'p', seed: 8, sentences, assets: pool });
  assert.deepEqual(first, second);
  assert.equal(first.manifest.timeline.length, 4);
  assert.equal(first.manifest.timeline.every((clip) => clip.sentenceIndex !== undefined && clip.sceneId), true);
  assert.equal(first.manifest.timeline.every((clip) => clip.sourceInMs + clip.durationMs <= 8_000), true);
});

test('script montage records explainable keyword matches and fallback', () => {
  const result = buildScriptMontageManifest({ projectId: 'p', seed: 1, script: '欧洲门店正在扩张。一个完全陌生的句子。', sentences: [], assets });
  assert.equal(result.manifest.timeline.length, 2);
  assert.equal(result.decisions[0]?.fallback, false);
  assert.equal(result.decisions[0]?.matchedKeywords.includes('欧洲'), true);
  assert.equal(result.decisions[1]?.fallback, true);
  assert.match(result.decisions[1]?.matchingReason || '', /兜底/);
});

test('random montage rejects a task that would reuse an asset', () => {
  assert.throws(() => buildRandomSentenceMontageManifest({ projectId: 'p', seed: 2, sentences: segmentScriptSentences('一。二。三。'), assets: [assets[0]!] }), /EDIT_UNIQUE_MEDIA_EXHAUSTED/);
});

test('script montage randomly selects local folder assets without filename matching', () => {
  const result = buildScriptMontageManifest({ projectId: 'p', seed: 2, script: '欧洲门店。销售数据。', sentences: [], assets: assets.map((asset) => ({ ...asset, metadata: { sourceType: 'LOCAL_MEDIA' } })) });
  assert.equal(new Set(result.manifest.timeline.map((clip) => clip.assetId)).size, 2);
  assert.equal(result.decisions.every((decision) => decision.matchingReason.includes('随机匹配')), true);
});

test('voice timing drives content duration and branding offsets subtitles', () => {
  const sentences = [0, 1, 2, 3, 4].map((index) => ({ index, text: `句子${index + 1}`, normalizedText: `句子${index + 1}`, voiceStartMs: index * 2_000, voiceEndMs: index * 2_000 + 1_200 }));
  const planned = buildScriptMontageManifest({ projectId: 'p', seed: 1, sentences, assets: [...assets, { ...assets[0]!, id: 'extra-voice-1' }, { ...assets[1]!, id: 'extra-voice-2' }] });
  assert.deepEqual(planned.manifest.timeline.map((clip) => clip.durationMs), [1_200, 1_200, 1_200, 1_200, 1_200]);
  const branded = assembleBrandedTimeline({ ...planned.manifest, subtitles: [{ text: '句子1', startMs: 0, endMs: 1_200 }] }, { intro: { id: 'intro', storageKey: 'intro.mp4', sourcePath: 'intro.mp4', durationMs: 2_000, role: 'INTRO' }, outro: { id: 'outro', storageKey: 'outro.mp4', sourcePath: 'outro.mp4', durationMs: 3_000, role: 'OUTRO' } });
  assert.equal(branded.timeline.filter((clip) => clip.role === 'CONTENT').length, 5);
  assert.equal(branded.timeline[0]?.role, 'INTRO');
  assert.equal(branded.timeline.at(-1)?.role, 'OUTRO');
  assert.deepEqual(branded.subtitles, [{ text: '句子1', startMs: 2_000, endMs: 3_200 }]);
});

test('voice timing accepts gaps, rejects overlaps, and falls back for partial timing', () => {
  const gap = buildScriptMontageManifest({ projectId: 'p', seed: 1, sentences: [{ index: 0, text: '甲', normalizedText: '甲', voiceStartMs: 0, voiceEndMs: 1_000 }, { index: 1, text: '乙', normalizedText: '乙', voiceStartMs: 1_500, voiceEndMs: 2_500 }], assets });
  assert.deepEqual(gap.manifest.timeline.map((clip) => clip.durationMs), [1_000, 1_000]);
  assert.throws(() => buildScriptMontageManifest({ projectId: 'p', seed: 1, sentences: [{ index: 0, text: '甲', normalizedText: '甲', voiceStartMs: 0, voiceEndMs: 1_500 }, { index: 1, text: '乙', normalizedText: '乙', voiceStartMs: 1_000, voiceEndMs: 2_000 }], assets }), /overlap/i);
  const partial = buildScriptMontageManifest({ projectId: 'p', seed: 1, sentences: [{ index: 0, text: '甲', normalizedText: '甲', voiceStartMs: 0 }], minClipDurationMs: 2_000, maxClipDurationMs: 5_000, assets });
  assert.equal(partial.manifest.timeline[0]?.durationMs, 2_000);
});
