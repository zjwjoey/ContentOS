import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanFilePart, outputFileStem, pairByBasename } from '../../apps/api/src/editing-workbench-routes.js';

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
