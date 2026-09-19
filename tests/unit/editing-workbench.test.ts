import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanFilePart, outputFileStem, pairByBasename, promoteStagedUpload, renderRetryIdempotencySuffix } from '../../apps/api/src/editing-workbench-routes.js';
import { fitSentencesToVoiceDuration, prepareVoiceTiming } from '../../packages/modules/video/src/edit-workbench-preparation.js';

test('editing workbench cleans Windows filename characters and preserves ordinal naming', () => {
  assert.equal(cleanFilePart('Action: 欧洲/门店?.mp4'), 'Action_ 欧洲_门店_.mp4');
  assert.equal(outputFileStem('门店宣传', 3), '003_门店宣传');
  assert.equal(cleanFilePart('...'), '未命名');
});

test('editing workbench groups variant output names by source ordinal', () => {
  assert.deepEqual([0, 1, 2].map((variant) => outputFileStem('标题', 1, variant, 3)), ['001_标题_A', '001_标题_B', '001_标题_C']);
  assert.deepEqual([0, 1, 2].map((variant) => outputFileStem('标题', 2, variant, 3)), ['002_标题_A', '002_标题_B', '002_标题_C']);
  assert.equal(outputFileStem('标题_A', 1, 0, 1), '001_标题_A');
  assert.equal(outputFileStem('标题_A', 1, 0, 3), '001_标题_A');
});

test('editing workbench advances render retry generation by previous failed job', () => {
  const first = renderRetryIdempotencySuffix('item-1', 'job-original');
  const duplicate = renderRetryIdempotencySuffix('item-1', 'job-original');
  const second = renderRetryIdempotencySuffix('item-1', 'job-retry-1');
  assert.equal(first, duplicate);
  assert.notEqual(first, second);
});

test('editing workbench pairs text and audio by basename without silently dropping files', () => {
  assert.deepEqual(pairByBasename(['001.txt', '002.md', '003.txt'], ['001.mp3', '002.wav', '004.m4a']), [
    { ordinal: 1, basename: '001', textFile: '001.txt', audioFile: '001.mp3', status: 'READY' },
    { ordinal: 2, basename: '002', textFile: '002.md', audioFile: '002.wav', status: 'READY' },
    { ordinal: 3, basename: '003', textFile: '003.txt', audioFile: null, status: 'MISSING_AUDIO' },
    { ordinal: 4, basename: '004', textFile: null, audioFile: '004.m4a', status: 'MISSING_TEXT' },
  ]);
});

test('editing workbench normalizes basename only with NFKC, trim, and case folding', () => {
  assert.deepEqual(pairByBasename(['  Folder\\ＡＢＣ.txt'], ['other/abc.MP3']), [
    { ordinal: 1, basename: 'abc', textFile: '  Folder\\ＡＢＣ.txt', audioFile: 'other/abc.MP3', status: 'READY' },
  ]);
});

test('editing workbench pairs across folders, preserves Chinese names, and reports missing files', () => {
  assert.deepEqual(pairByBasename(['F:\\文案\\门店01.txt', 'F:\\文案\\003.TXT'], ['D:\\配音\\门店01.MP3', 'D:\\配音\\004.wav']), [
    { ordinal: 1, basename: '003', textFile: 'F:\\文案\\003.TXT', audioFile: null, status: 'MISSING_AUDIO' },
    { ordinal: 2, basename: '004', textFile: null, audioFile: 'D:\\配音\\004.wav', status: 'MISSING_TEXT' },
    { ordinal: 3, basename: '门店01', textFile: 'F:\\文案\\门店01.txt', audioFile: 'D:\\配音\\门店01.MP3', status: 'READY' },
  ]);
});

test('editing workbench exposes duplicate basenames instead of overwriting them', () => {
  assert.deepEqual(pairByBasename(['one/a.txt', 'two/A.md'], ['one/a.mp3']), [
    { ordinal: 1, basename: 'a', textFile: 'one/a.txt', audioFile: 'one/a.mp3', status: 'DUPLICATE_TEXT_BASENAME' },
  ]);
  assert.deepEqual(pairByBasename(['a.txt'], ['one/a.mp3', 'two/A.wav']), [
    { ordinal: 1, basename: 'a', textFile: 'a.txt', audioFile: 'one/a.mp3', status: 'DUPLICATE_AUDIO_BASENAME' },
  ]);
});

test('editing workbench promotes staged uploads through a target-volume part file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-edit-upload-'));
  const staged = join(root, 'staging.tmp');
  const destination = join(root, 'uploads', 'voice.mp3');
  await mkdir(join(root, 'uploads'), { recursive: true });
  await writeFile(staged, 'audio-bytes');
  await promoteStagedUpload(staged, destination);
  assert.equal(await readFile(destination, 'utf8'), 'audio-bytes');
  assert.equal((await readdir(join(root, 'uploads'))).some((name) => name.endsWith('.part')), false);
  await assert.rejects(() => readFile(staged));
});

test('editing workbench never overwrites an existing upload destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-edit-upload-existing-'));
  const staged = join(root, 'staging.tmp');
  const destination = join(root, 'uploads', 'voice.mp3');
  await mkdir(join(root, 'uploads'), { recursive: true });
  await writeFile(staged, 'new-audio');
  await writeFile(destination, 'old-audio');
  await assert.rejects(() => promoteStagedUpload(staged, destination), /EDIT_UPLOAD_DESTINATION_EXISTS/);
  assert.equal(await readFile(destination, 'utf8'), 'old-audio');
});

test('editing workbench fits script visuals to the uploaded voice duration', () => {
  const sentences = [
    { index: 0, text: '第一句文案。', normalizedText: '第一句文案' },
    { index: 1, text: '第二句文案比较长。', normalizedText: '第二句文案比较长' },
    { index: 2, text: '第三句。', normalizedText: '第三句' },
  ];
  const fitted = fitSentencesToVoiceDuration(sentences, 53_000);
  assert.equal(fitted.reduce((total, sentence) => total + Number(sentence.durationMs || 0), 0), 53_000);
  assert.ok(fitted.every((sentence) => Number(sentence.durationMs) > 0));
});

test('editing workbench reuses worker-prepared voice timing without importing voice again', async () => {
  let imports = 0;
  const sentences = [{ index: 0, text: '第一句。', normalizedText: '第一句', durationMs: 4_000 }];
  const timing = await prepareVoiceTiming({ assetService: { importFile: async () => { imports += 1; return { id: 'unexpected' }; } } as never, assets: {} as never }, { workspaceId: 'workspace', script: '不同文案。', voiceAssetId: 'voice-1', sentences });
  assert.equal(imports, 0);
  assert.equal(timing.voiceAssetId, 'voice-1');
  assert.deepEqual(timing.sentences, sentences);
});
