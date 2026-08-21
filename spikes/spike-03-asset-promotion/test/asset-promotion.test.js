const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AssetPromotionStore, sha256File } = require('../src/asset-promotion');

let root;
let incoming;
let store;

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'contentos-spike03-'));
  incoming = path.join(root, 'incoming', '素材-中文.mp4');
  await fs.mkdir(path.dirname(incoming), { recursive: true });
  await fs.writeFile(incoming, Buffer.from('same deterministic media bytes\n', 'utf8'));
  store = new AssetPromotionStore(path.join(root, 'asset-store'));
  await store.initialize();
});

test.afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('content-addressed promotion deduplicates identical assets', async () => {
  const first = await store.stage({ sourcePath: incoming, assetId: 'asset-中文-1', originalName: '素材-中文.mp4' });
  const firstPromotion = await store.promote(first);
  const second = await store.stage({ sourcePath: incoming, assetId: 'asset-中文-2', originalName: '素材-中文-copy.mp4' });
  const secondPromotion = await store.promote(second);
  assert.equal(firstPromotion.status, 'PROMOTED');
  assert.equal(secondPromotion.status, 'DEDUPED');
  assert.equal(secondPromotion.destination, firstPromotion.destination);
  assert.equal(await sha256File(firstPromotion.destination), first.checksum);
  assert.equal((await fs.readdir(path.join(store.objectsDir, first.checksum.slice(0, 2)))).length, 1);
});

test('Unicode source path and original name survive metadata promotion', async () => {
  const staged = await store.stage({ sourcePath: incoming, assetId: '素材-中文', originalName: '素材-中文.mp4' });
  const promoted = await store.promote(staged);
  const metadata = JSON.parse(await fs.readFile(promoted.metadataPath, 'utf8'));
  assert.equal(metadata.originalName, '素材-中文.mp4');
  assert.equal(metadata.assetId, '素材-中文');
  assert.match(metadata.path, /objects/);
});

test('checksum mismatch blocks promotion and preserves staged evidence', async () => {
  const staged = await store.stage({ sourcePath: incoming, assetId: 'bad-checksum', originalName: 'bad.mp4' });
  const result = await store.promote({ ...staged, checksum: '0'.repeat(64) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error.code, 'CHECKSUM_MISMATCH');
  assert.equal(await fs.stat(staged.stagedPath).then(() => true), true);
});

test('crash window leaves no final object and cleanup removes stale temp files', async () => {
  const staged = await store.stage({ sourcePath: incoming, assetId: 'crash-window', originalName: '素材-中文.mp4' });
  const result = await store.promote({ ...staged, simulateCrashAfterCopy: true });
  assert.equal(result.status, 'CRASHED_BEFORE_RENAME');
  assert.equal(await fs.stat(store.objectPath(staged.checksum)).then(() => false, () => true), true);
  assert.equal(await fs.stat(result.tempDestination).then(() => true), true);
  const cleaned = await store.cleanup({ olderThanMs: 0 });
  assert.ok(cleaned.removed.includes(result.tempDestination));
  assert.equal(await fs.stat(result.tempDestination).then(() => false, () => true), true);
});

test('atomic promotion does not leave part files after success', async () => {
  const staged = await store.stage({ sourcePath: incoming, assetId: 'atomic', originalName: '素材-中文.mp4' });
  const result = await store.promote(staged);
  assert.equal(result.status, 'PROMOTED');
  assert.equal(await fs.stat(staged.stagedPath).then(() => false, () => true), true);
  assert.equal((await store.cleanup({ olderThanMs: 0 })).removed.length, 0);
  assert.deepEqual(await fs.readdir(path.dirname(result.destination)), [staged.checksum]);
});
