const fs = require('node:fs/promises');
const path = require('node:path');
const { generateFixtures, createManifest, renderManifest, probeMedia, closeRenderer } = require('./video-render');

(async () => {
  const root = path.resolve(__dirname, '..');
  const fixtures = path.join(root, 'fixtures');
  const outputs = path.join(root, 'outputs');
  await fs.mkdir(outputs, { recursive: true });
  await generateFixtures(fixtures);
  const results = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const manifest = await createManifest({ fixtureDir: fixtures, voiceDuration: 30, randomSeed: seed });
    const outputPath = path.join(outputs, `seed-${seed}.mp4`);
    const rendered = await renderManifest({ manifest, fixtureDir: fixtures, outputPath, subtitlesPath: path.join(fixtures, '中文字幕.srt') });
    if (rendered.status !== 'SUCCEEDED') throw new Error(`seed ${seed} failed: ${JSON.stringify(rendered.error)}`);
    results.push({ seed, output: path.basename(outputPath), clipCount: manifest.timeline.video.length, sourceOrder: manifest.timeline.video.map((clip) => clip.sourceRef), media: await probeMedia(outputPath) });
  }
  await fs.writeFile(path.join(outputs, 'run-summary.json'), JSON.stringify({ spike: 'SPIKE_02_VIDEO_RENDER', ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', seeds: results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => closeRenderer());
