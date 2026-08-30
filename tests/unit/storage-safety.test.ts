import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';

test('local storage object paths stay inside the configured root', () => {
  const storage = new LocalStorageProvider('E:/contentos/storage');
  assert.throws(() => storage.objectPath('../outside.txt'), /Invalid storage object path/);
  assert.throws(() => storage.objectPath('objects/..\\outside.txt'), /Invalid storage object path/);
  assert.throws(() => storage.objectPath('C:/outside.txt'), /Invalid storage object path/);
  assert.match(storage.objectPath('objects/aa/blob'), /storage[\\/]objects[\\/]aa[\\/]blob$/i);
});

test('local storage promotion rejects a staged temp path outside staging', async () => {
  const storage = new LocalStorageProvider('E:/contentos/storage');
  await assert.rejects(
    () => storage.promote({ tempPath: 'E:/outside/file.part', checksum: 'sha256:' + 'a'.repeat(64), byteSize: 1, originalName: 'file.mp4' }),
    /Invalid staged temp path/,
  );
});
