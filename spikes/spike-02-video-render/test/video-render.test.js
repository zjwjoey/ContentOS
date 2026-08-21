const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  generateFixtures,
  createManifest,
  renderManifest,
  probeMedia,
  validateManifest,
  closeRenderer,
} = require('../src/video-render');

const root = path.resolve(__dirname, '..');
const fixtures = path.join(root, 'fixtures');
const outputs = path.join(root, 'outputs');

test.before(async () => {
  await generateFixtures(fixtures);
});

test.after(async () => {
  await closeRenderer();
});

test('seeded planner is reproducible and avoids adjacent source duplicates', async () => {
  const first = await createManifest({ fixtureDir: fixtures, voiceDuration: 30, randomSeed: 7 });
  const second = await createManifest({ fixtureDir: fixtures, voiceDuration: 30, randomSeed: 7 });
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 'EDIT_MANIFEST_V0');
  for (let i = 1; i < first.timeline.video.length; i += 1) {
    assert.notEqual(first.timeline.video[i - 1].sourceRef, first.timeline.video[i].sourceRef);
  }
  assert.equal(validateManifest(first).valid, true);
});

test('manifest renders portrait MP4 with voice, subtitles and a non-cut fade transition', async () => {
  const manifest = await createManifest({ fixtureDir: fixtures, voiceDuration: 30, randomSeed: 11 });
  const output = path.join(outputs, 'seed-11.mp4');
  const result = await renderManifest({ manifest, fixtureDir: fixtures, outputPath: output, subtitlesPath: path.join(fixtures, '中文字幕.srt') });
  assert.equal(result.status, 'SUCCEEDED');
  assert.match(result.command, /fade=/);
  const media = await probeMedia(output);
  assert.equal(media.width, 1080);
  assert.equal(media.height, 1920);
  assert.ok(Math.abs(media.duration - 30) <= 0.5, `duration=${media.duration}`);
  assert.ok((await fs.stat(output)).size > 1000);
});

test('invalid manifest returns a structured validation error before FFmpeg', async () => {
  const manifest = await createManifest({ fixtureDir: fixtures, voiceDuration: 30, randomSeed: 13 });
  manifest.timeline.video[0].sourceOutMs = 0;
  const result = await renderManifest({ manifest, fixtureDir: fixtures, outputPath: path.join(outputs, 'invalid.mp4') });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error.code, 'MANIFEST_INVALID');
  assert.equal(result.error.details[0].field, 'timeline.video[0].sourceOutMs');
});

test('corrupted media is reported as a renderer failure instead of crashing the planner', async () => {
  const corrupted = path.join(fixtures, '损坏-素材.mp4');
  await fs.writeFile(corrupted, Buffer.from('not a media file', 'utf8'));
  const manifest = await createManifest({ fixtureDir: fixtures, voiceDuration: 30, randomSeed: 19 });
  manifest.timeline.video[0].sourceRef = path.basename(corrupted);
  const result = await renderManifest({ manifest, fixtureDir: fixtures, outputPath: path.join(outputs, 'corrupted.mp4') });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error.code, 'FFMPEG_FAILED');
});

test('interrupted render never reports success or leaves a completed output', async () => {
  const manifest = await createManifest({ fixtureDir: fixtures, voiceDuration: 30, randomSeed: 17 });
  const output = path.join(outputs, 'interrupted.mp4');
  const result = await renderManifest({ manifest, fixtureDir: fixtures, outputPath: output, interruptAfterMs: 150 });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error.code, 'RENDER_INTERRUPTED');
  await assert.rejects(() => fs.stat(output));
});
