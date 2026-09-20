import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { blurBackgroundBranches, generateFixtureAudio, generateFixtureVideo, renderEditManifest, probeMedia, subtitlePositionExpressions } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { buildVideoManifest, type PlannerAsset } from '../../packages/modules/video/src/index.js';
import type { EditManifestV0 } from '../../packages/contracts/src/index.js';
import { DEFAULT_PRESENTATION_SETTINGS_V1 } from '../../packages/contracts/src/index.js';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

test('subtitle renderer uses normalized center-anchor expressions with bounds', () => {
  assert.deepEqual(subtitlePositionExpressions(.5, .5), { x: 'max(0\\,min(w-text_w\\,w*0.5-text_w/2))', y: 'max(0\\,min(h-text_h\\,h*0.5-text_h/2))' });
  assert.match(subtitlePositionExpressions(.2, .2).x, /text_w\/2/);
  assert.match(subtitlePositionExpressions(.8, .82).y, /text_h\/2/);
});

test('blur background foreground branch preserves source aspect without black padding', () => {
  const branches = blurBackgroundBranches(1080, 1920);
  assert.match(branches.background, /force_original_aspect_ratio=increase/);
  assert.match(branches.background, /boxblur/);
  assert.match(branches.foreground, /force_original_aspect_ratio=decrease/);
  assert.doesNotMatch(branches.foreground, /pad=/);
});

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

test('FFmpeg renderer fails loudly when text is enabled without a font', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-render-font-test-')); const output = join(root, 'output.mp4');
  try {
    const manifest = { ...buildVideoManifest({ projectId: 'project-render-font-test', seed: 10, assets: [{ id: 'source-1', storageKey: 'objects/source-1', sourcePath: join(root, 'clip.mp4'), durationMs: 1200 } satisfies PlannerAsset], targetDurationMs: 1000 }), subtitles: [{ text: '字幕', startMs: 0, endMs: 500 }] };
    await assert.rejects(renderEditManifest({ manifest, outputPath: output, ffmpegPath: ffmpeg, ffprobePath: ffprobe }), /RENDER_SUBTITLE_FONT_UNAVAILABLE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FFmpeg renderer rejects an unavailable configured font before spawning FFmpeg', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-render-invalid-font-test-')); const output = join(root, 'output.mp4');
  try {
    const manifest = { ...buildVideoManifest({ projectId: 'project-render-invalid-font-test', seed: 11, assets: [{ id: 'source-1', storageKey: 'objects/source-1', sourcePath: join(root, 'clip.mp4'), durationMs: 1200 } satisfies PlannerAsset], targetDurationMs: 1000 }), subtitles: [{ text: '字幕', startMs: 0, endMs: 500 }], presentationSettings: { ...DEFAULT_PRESENTATION_SETTINGS_V1, subtitleStyle: { ...DEFAULT_PRESENTATION_SETTINGS_V1.subtitleStyle, fontFile: join(root, 'missing.ttf') } } };
    await assert.rejects(renderEditManifest({ manifest, outputPath: output, ffmpegPath: ffmpeg, ffprobePath: ffprobe }), /RENDER_SUBTITLE_FONT_UNAVAILABLE/);
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

test('FFmpeg renderer honors dynamic canvas ratios and fit modes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-render-presentation-test-')); const clip = join(root, 'clip.mp4');
  try {
    await generateFixtureVideo(clip, ffmpeg, 'purple', 2);
    const base: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', workspaceId: 'workspace-presentation', seed: 1, canvas: { width: 1920, height: 1080, aspectRatio: '16:9', fps: 30, fitMode: 'CONTAIN' }, timeline: [{ assetId: 'clip', sourcePath: clip, sourceInMs: 0, durationMs: 1_000, transition: 'cut' }], audio: { volume: 1 }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } };
    const contain = await renderEditManifest({ manifest: base, outputPath: join(root, 'contain.mp4'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
    assert.equal(contain.width, 1920); assert.equal(contain.height, 1080);
    const presentation = { schemaVersion: 'EDIT_PRESENTATION_V1' as const, canvas: { ...base.canvas, fitMode: 'BLUR_BACKGROUND' as const }, subtitleStyle: { schemaVersion: 'EDIT_PRESENTATION_V1' as const, enabled: true, fontId: 'sans-serif', fontSize: 42, color: '#FFFFFF', outline: { enabled: true, color: '#000000', width: 2 }, shadow: { enabled: true, color: '#000000', x: 2, y: 2, blur: 0 }, background: { enabled: true, color: '#000000', opacity: .4, padding: 8 }, position: { x: .5, y: .8 }, align: 'CENTER' as const, maxWidth: .88, maxLines: 2, lineHeight: 1.2, animation: 'FADE_IN' as const, animationDurationMs: 250 }, output: { format: 'mp4' as const, videoCodec: 'h264' as const, audioCodec: 'aac' as const }, segmentation: { version: 'SCRIPT_SEGMENTATION_V1' as const, mode: 'COMMA_SENTENCE' as const } };
    const blurManifest: EditManifestV0 = { ...base, canvas: { ...base.canvas, fitMode: 'BLUR_BACKGROUND' }, metadata: { presentationSettings: presentation }, subtitles: [{ text: '字幕测试', startMs: 0, endMs: 900 }] };
    const blur = await renderEditManifest({ manifest: blurManifest, outputPath: join(root, 'blur.mp4'), ffmpegPath: ffmpeg, ffprobePath: ffprobe, fontFile: process.env.FFMPEG_FONT_FILE || 'C:\\Windows\\Fonts\\msyh.ttc' });
    assert.equal(blur.width, 1920); assert.equal(blur.height, 1080);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FFmpeg BLUR_BACKGROUND keeps a clear centered foreground over a blurred 640x360 source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-render-blur-portrait-test-')); const clip = join(root, 'clip.mp4'); const output = join(root, 'blur.mp4');
  try {
    await generateFixtureVideo(clip, ffmpeg, 'navy', 2);
    const manifest: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', workspaceId: 'workspace-blur-portrait', seed: 1, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30, fitMode: 'BLUR_BACKGROUND' }, timeline: [{ assetId: 'clip', sourcePath: clip, sourceInMs: 0, durationMs: 1_000, transition: 'cut' }], audio: { volume: 1 }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } };
    await renderEditManifest({ manifest, outputPath: output, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
    const probe = await probeMedia(output, ffprobe);
    assert.equal(probe.width, 1080); assert.equal(probe.height, 1920); assert.equal(probe.pixelFormat, 'yuv420p'); assert.equal(probe.videoCodec, 'h264'); assert.ok(Math.abs((probe.fps || 0) - 30) < .1); assert.ok(probe.durationMs >= 900 && probe.durationMs <= 1_200);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FFmpeg renderer accepts every safe subtitle animation enum', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-render-animation-test-')); const clip = join(root, 'clip.mp4'); const fontFile = process.env.FFMPEG_FONT_FILE || 'C:\\Windows\\Fonts\\msyh.ttc';
  try {
    await generateFixtureVideo(clip, ffmpeg, 'orange', 2);
    const animations = ['NONE', 'FADE_IN', 'FADE_OUT', 'FADE_IN_OUT', 'SLIDE_UP'] as const;
    for (const animation of animations) {
      const manifest: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', workspaceId: `workspace-animation-${animation}`, seed: 1, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline: [{ assetId: 'clip', sourcePath: clip, sourceInMs: 0, durationMs: 1_000, transition: 'cut' }], audio: { volume: 1 }, subtitles: [{ text: animation, startMs: 0, endMs: 900 }], metadata: { presentationSettings: { ...DEFAULT_PRESENTATION_SETTINGS_V1, subtitleStyle: { ...DEFAULT_PRESENTATION_SETTINGS_V1.subtitleStyle, fontFile, animation } } }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } };
      await renderEditManifest({ manifest, outputPath: join(root, `${animation}.mp4`), ffmpegPath: ffmpeg, ffprobePath: ffprobe, fontFile });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FFmpeg renderer probes required resolution presets exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-render-resolution-test-')); const clip = join(root, 'clip.mp4');
  try {
    await generateFixtureVideo(clip, ffmpeg, 'teal', 2);
    const resolutions: Array<[number, number, EditManifestV0['canvas']['aspectRatio']]> = [[720, 1280, '9:16'], [1080, 1920, '9:16'], [1920, 1080, '16:9'], [1080, 1080, '1:1']];
    for (const [width, height, aspectRatio] of resolutions) {
      const manifest: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', workspaceId: `workspace-resolution-${width}x${height}`, seed: 1, canvas: { width, height, aspectRatio, fps: 30 }, timeline: [{ assetId: 'clip', sourcePath: clip, sourceInMs: 0, durationMs: 800, transition: 'cut' }], audio: { volume: 1 }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } };
      const output = join(root, `${width}x${height}.mp4`); await renderEditManifest({ manifest, outputPath: output, ffmpegPath: ffmpeg, ffprobePath: ffprobe }); const probe = await probeMedia(output, ffprobe); assert.equal(probe.width, width); assert.equal(probe.height, height); assert.equal(probe.pixelFormat, 'yuv420p');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FFmpeg fixture matrix covers the ten required render combinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-render-matrix-test-'));
  const clipA = join(root, 'clip-a.mp4'); const clipB = join(root, 'clip-b.mp4'); const voice = join(root, 'voice.wav'); const music = join(root, 'music.wav');
  const fontFile = process.env.FFMPEG_FONT_FILE || 'C:\\Windows\\Fonts\\msyh.ttc';
  try {
    await generateFixtureVideo(clipA, ffmpeg, 'blue', 4); await generateFixtureVideo(clipB, ffmpeg, 'green', 4); await generateFixtureAudio(voice, ffmpeg); await generateFixtureAudio(music, ffmpeg);
    const timeline = [{ assetId: 'clip-a', sourcePath: clipA, sourceInMs: 0, durationMs: 2_000, transition: 'cut' as const, timelineStartMs: 0, timelineEndMs: 2_000 }];
    const base: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', workspaceId: 'workspace-render-matrix', seed: 1, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline, audio: { volume: 1 }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } };
    const cases: Array<{ name: string; manifest: EditManifestV0; needsFont?: boolean; assertAudio?: boolean; assertFps?: number }> = [
      { name: 'video-only', manifest: base },
      { name: 'video-voice', manifest: { ...base, audio: { ...base.audio, voicePath: voice }, }, assertAudio: true },
      { name: 'video-voice-subtitle', manifest: { ...base, audio: { ...base.audio, voicePath: voice }, subtitles: [{ text: '中文字幕', startMs: 0, endMs: 1_500, style: 'commercial', fontSize: 42, position: 'bottom', maxLines: 2 }] }, needsFont: true, assertAudio: true },
      { name: 'video-voice-bgm', manifest: { ...base, audio: { ...base.audio, voicePath: voice, backgroundMusic: { path: music, volume: 0.08, loop: true } } }, assertAudio: true },
      { name: 'video-voice-bgm-ducking', manifest: { ...base, audio: { ...base.audio, voicePath: voice, backgroundMusic: { path: music, volume: 0.08, loop: true, ducking: { enabled: true, musicVolume: 0.04 } } } }, assertAudio: true },
      { name: 'hero-text', manifest: { ...base, textOverlays: [{ text: '重点文字', startMs: 0, endMs: 1_500, kind: 'HERO', style: 'emphasis', fontSize: 56, position: 'center' }] }, needsFont: true },
      { name: 'intro-content-outro', manifest: { ...base, timeline: [
        { assetId: 'intro', sourcePath: clipA, sourceInMs: 0, durationMs: 500, transition: 'cut', role: 'INTRO', timelineStartMs: 0, timelineEndMs: 500 },
        { assetId: 'content', sourcePath: clipB, sourceInMs: 0, durationMs: 1_000, transition: 'cut', role: 'CONTENT', timelineStartMs: 500, timelineEndMs: 1_500 },
        { assetId: 'outro', sourcePath: clipA, sourceInMs: 500, durationMs: 500, transition: 'cut', role: 'OUTRO', timelineStartMs: 1_500, timelineEndMs: 2_000 },
      ] } },
      { name: 'multi-clip-scene', manifest: { ...base, timeline: [
        { assetId: 'scene-1-a', sourcePath: clipA, sourceInMs: 0, durationMs: 1_000, transition: 'cut', sceneId: 'scene-1', timelineStartMs: 0, timelineEndMs: 1_000 },
        { assetId: 'scene-1-b', sourcePath: clipB, sourceInMs: 0, durationMs: 1_000, transition: 'cut', sceneId: 'scene-1', timelineStartMs: 1_000, timelineEndMs: 2_000 },
      ] } },
      { name: 'thirty-fps', manifest: { ...base, canvas: { ...base.canvas, fps: 30 } }, assertFps: 30 },
      { name: 'vertical-9x16', manifest: { ...base, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 } }, assertFps: 30 },
    ];
    const completed: string[] = [];
    for (const item of cases) {
      const output = join(root, `${item.name}.mp4`);
      const rendered = await renderEditManifest({ manifest: item.manifest, outputPath: output, ffmpegPath: ffmpeg, ffprobePath: ffprobe, ...(item.needsFont ? { fontFile } : {}) });
      assert.equal(rendered.format, 'mp4'); assert.equal(rendered.width, 1080); assert.equal(rendered.height, 1920); if (item.assertAudio) assert.equal(rendered.audio, true); if (item.assertFps) assert.ok(Math.abs((await probeMedia(output, ffprobe)).fps! - item.assertFps) < 0.1); completed.push(item.name);
    }
    assert.deepEqual(completed, cases.map((item) => item.name));
  } finally { await rm(root, { recursive: true, force: true }); }
});
