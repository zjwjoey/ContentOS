import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanFilePart, outputFileStem, pairByBasename, promoteStagedUpload } from '../../apps/api/src/editing-workbench-routes.js';

test('editing workbench cleans Windows filename characters and preserves ordinal naming', () => {
  assert.equal(cleanFilePart('Action: 欧洲/门店?.mp4'), 'Action_ 欧洲_门店_.mp4');
  assert.equal(outputFileStem('门店宣传', 3), '003_门店宣传');
  assert.equal(cleanFilePart('...'), '未命名');
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
