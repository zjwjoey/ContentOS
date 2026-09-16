import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRandomSentenceMontageManifest, buildScriptMontageManifest, segmentScriptSentences, type SentenceMontageAsset } from '../../packages/modules/video/src/index.js';

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
  const first = buildRandomSentenceMontageManifest({ projectId: 'p', seed: 8, sentences, assets });
  const second = buildRandomSentenceMontageManifest({ projectId: 'p', seed: 8, sentences, assets });
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

test('random montage permits repeated assets only when the library is insufficient', () => {
  const result = buildRandomSentenceMontageManifest({ projectId: 'p', seed: 2, sentences: segmentScriptSentences('一。二。三。'), assets: [assets[0]!] });
  assert.equal(result.manifest.timeline.length, 3);
  assert.equal(result.decisions.every((decision) => decision.fallback || decision.sentenceIndex === 0), true);
});
