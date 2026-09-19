import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateFixtureAudio, generateFixtureVideo, renderEditManifest, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
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
    assert.equal(probed.videoCodec, 'h264');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FFmpeg renderer honors an aborted render signal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-render-cancel-test-'));
  const clip = join(root, 'clip.mp4');
  const output = join(root, 'output.mp4');
  const controller = new AbortController();
  controller.abort(new DOMException('render cancelled', 'AbortError'));
  try {
    await assert.rejects(
      renderEditManifest({
        manifest: buildVideoManifest({ projectId: 'project-render-cancel-test', seed: 8, assets: [{ id: 'source-1', storageKey: 'objects/source-1', sourcePath: clip, durationMs: 1200 } satisfies PlannerAsset], targetDurationMs: 1000 }),
        outputPath: output,
        ffmpegPath: ffmpeg,
        ffprobePath: ffprobe,
        signal: controller.signal,
      }),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FFmpeg renderer terminates active work and removes partial output on abort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-render-active-cancel-test-'));
  const clip = join(root, 'clip.mp4');
  const output = join(root, 'output.mp4');
  const controller = new AbortController();
  try {
    await generateFixtureVideo(clip, ffmpeg);
    const rendering = renderEditManifest({
      manifest: buildVideoManifest({ projectId: 'project-render-active-cancel-test', seed: 9, assets: [
        { id: 'source-1', storageKey: 'objects/source-1', sourcePath: clip, durationMs: 2000 } satisfies PlannerAsset,
        { id: 'source-2', storageKey: 'objects/source-2', sourcePath: clip, durationMs: 2000 } satisfies PlannerAsset,
      ], targetDurationMs: 30_000 }),
      outputPath: output,
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new DOMException('render cancelled', 'AbortError')), 25);
    await assert.rejects(rendering, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    await assert.rejects(readFile(output));
    assert.equal((await readdir(root)).some((file) => file.endsWith('.part.mp4')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FFmpeg renderer mixes looped BGM and renders every subtitle/hero cue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-render-bgm-test-')); const clip = join(root, 'clip.mp4'); const music = join(root, 'music.wav'); const output = join(root, 'output.mp4');
  try {
    await generateFixtureVideo(clip, ffmpeg, 'blue', 4); await generateFixtureAudio(music, ffmpeg);
    const manifest = { schemaVersion: 'EDIT_MANIFEST_V0' as const, workspaceId: 'workspace-bgm-test', seed: 1, canvas: { width: 1080 as const, height: 1920 as const, aspectRatio: '9:16' as const, fps: 30 }, timeline: [{ assetId: 'clip', sourcePath: clip, sourceInMs: 0, durationMs: 3_000, transition: 'cut' as const, timelineStartMs: 0, timelineEndMs: 3_000 }], audio: { voicePath: music, volume: 1, backgroundMusic: { path: music, volume: 0.08, loop: true, ducking: { enabled: true, musicVolume: 0.05 } } }, subtitles: [{ text: '中文 € 14% \'quoted\'', startMs: 0, endMs: 1_500, style: 'commercial' as const, fontSize: 42, position: 'bottom' as const, maxLines: 2 }], textOverlays: [{ text: '重点文字', startMs: 1_500, endMs: 2_800, kind: 'HERO' as const, style: 'emphasis' as const, fontSize: 56, position: 'center' as const }], output: { format: 'mp4' as const, videoCodec: 'h264' as const, audioCodec: 'aac' as const } };
    const rendered = await renderEditManifest({ manifest, outputPath: output, ffmpegPath: ffmpeg, ffprobePath: ffprobe, fontFile: process.env.FFMPEG_FONT_FILE || 'C:\\Windows\\Fonts\\msyh.ttc' });
    assert.ok(rendered.audio); assert.ok(rendered.durationMs >= 2_900 && rendered.durationMs <= 3_200);
  } finally { await rm(root, { recursive: true, force: true }); }
});
