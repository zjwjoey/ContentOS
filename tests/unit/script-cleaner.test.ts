import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanAndSegmentScriptV1, mergeScriptSegmentsV1, splitScriptSegmentV1 } from '../../packages/modules/video/src/index.js';

test('presentation cleaner splits commas while protecting URLs, decimals, A/B and H.264', () => {
  const result = cleanAndSegmentScriptV1('Pepco 开了 2.5 家店，覆盖 A/B 测试，访问 https://example.com/a.b，支持 H.264。下一句！');
  assert.deepEqual(result.segments.map((item) => item.text), ['Pepco 开了 2.5 家店', '覆盖 A/B 测试', '访问 https://example.com/a.b', '支持 H.264', '下一句!']);
});

test('sentence-only and custom modes are deterministic', () => {
  assert.equal(cleanAndSegmentScriptV1('甲，乙。丙！', { mode: 'SENTENCE_ONLY' }).segments.length, 2);
  assert.deepEqual(cleanAndSegmentScriptV1('甲|乙|丙', { mode: 'CUSTOM', delimiters: ['|'] }).segments.map((item) => item.text), ['甲', '乙', '丙']);
});

test('confirmed segments can be merged, split and reindexed', () => {
  const source = cleanAndSegmentScriptV1('甲，乙，丙').segments;
  const merged = mergeScriptSegmentsV1(source, 0);
  assert.deepEqual(merged.map((item) => item.text), ['甲乙', '丙']);
  const split = splitScriptSegmentV1(merged, 0, 1);
  assert.deepEqual(split.map((item) => item.text), ['甲', '乙', '丙']);
  assert.deepEqual(split.map((item) => item.index), [0, 1, 2]);
});
