import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderEditManifest, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { buildVideoManifest, type PlannerAsset } from '../../packages/modules/video/src/index.js';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

test('FFmpeg renderer creates a playable vertical MP4 and probe validates it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-render-test-'));
  const clip = join(root, 'clip.mp4');
  const output = join(root, 'output.mp4');
  try {
    const generated = await renderEditManifest({
      manifest: buildVideoManifest({ projectId: 'project-render-test', seed: 7, assets: [{ id: 'source-1', storageKey: 'objects/source-1', sourcePath: clip, durationMs: 1200 } satisfies PlannerAsset], targetDurationMs: 1000 }),
      outputPath: output,
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
    }, { generateFixtureInput: true, fixturePath: clip });
    assert.equal(generated.outputPath, output);
    const stat = await readFile(output);
    assert.ok(stat.byteLength > 0);
    const probed = await probeMedia(output, ffprobe);
    assert.equal(probed.width, 1080);
    assert.equal(probed.height, 1920);
    assert.equal(probed.format, 'mp4');
  } finally { await rm(root, { recursive: true, force: true }); }
});
