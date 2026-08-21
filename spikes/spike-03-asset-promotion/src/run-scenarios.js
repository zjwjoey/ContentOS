const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AssetPromotionStore } = require('./asset-promotion');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contentos-spike03-run-'));
  const incoming = path.join(root, 'incoming', '素材-中文.mp4');
  await fs.mkdir(path.dirname(incoming), { recursive: true });
  await fs.writeFile(incoming, Buffer.from('spike 03 deterministic media bytes\n', 'utf8'));
  const store = new AssetPromotionStore(path.join(root, 'store'));
  await store.initialize();
  const staged = await store.stage({ sourcePath: incoming, assetId: '素材-中文', originalName: '素材-中文.mp4' });
  const promoted = await store.promote(staged);
  const duplicate = await store.promote(await store.stage({ sourcePath: incoming, assetId: 'duplicate', originalName: 'duplicate.mp4' }));
  const crashIncoming = path.join(root, 'incoming', 'crash-素材.mp4');
  await fs.writeFile(crashIncoming, Buffer.from('spike 03 crash-window bytes\n', 'utf8'));
  const crashStaged = await store.stage({ sourcePath: crashIncoming, assetId: 'crash', originalName: 'crash-素材.mp4' });
  const crash = await store.promote({ ...crashStaged, simulateCrashAfterCopy: true });
  const cleanup = await store.cleanup({ olderThanMs: 0 });
  const result = { spike: 'SPIKE_03_ASSET_PROMOTION', promoted, duplicate, crash: { status: crash.status }, cleanupCount: cleanup.removed.length, checksum: staged.checksum };
  const evidenceDir = path.resolve(__dirname, '..', '..', 'evidence');
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, 'SPIKE_03_RUN_SUMMARY.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
  await fs.rm(root, { recursive: true, force: true });
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
