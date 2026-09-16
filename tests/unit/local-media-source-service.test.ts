import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalMediaSourceService } from '../../packages/modules/asset/src/index.js';

test('local media scanner enforces authorized roots and returns safe relative files', async () => {
  const root = join(tmpdir(), `contentos-media-${Date.now()}`); await mkdir(join(root, '子文件夹'), { recursive: true });
  await writeFile(join(root, 'ignore.txt'), 'not video'); await writeFile(join(root, '子文件夹', '中文.mp4'), 'fixture');
  const scanner = new LocalMediaSourceService({ allowedRoots: [root], probe: async (path) => ({ format: 'mp4', durationMs: 3200, width: 1920, height: 1080, audio: false, ...(path.includes('中文') ? { videoCodec: 'h264' } : {}) }) });
  const result = await scanner.scan({ sourceRoot: root, recursive: true });
  assert.equal(result.totalCount, 1); assert.equal(result.availableCount, 1); assert.equal(result.files[0]?.relativePath, '子文件夹/中文.mp4'); assert.equal('sourcePath' in LocalMediaSourceService.toPublicFile(result.files[0]!), false);
  assert.throws(() => scanner.authorizeRoot(join(root, '..')), /UNAUTHORIZED/);
});

test('local media scanner handles unreadable media without failing the whole folder', async () => {
  const root = join(tmpdir(), `contentos-media-bad-${Date.now()}`); await mkdir(root); await writeFile(join(root, 'bad.mkv'), 'broken');
  const scanner = new LocalMediaSourceService({ allowedRoots: [root], probe: async () => { throw new Error('probe failed'); } });
  const result = await scanner.scan({ sourceRoot: root, recursive: false });
  assert.equal(result.totalCount, 1); assert.equal(result.availableCount, 0); assert.equal(result.unavailableCount, 1); assert.equal(result.files[0]?.available, false);
});
