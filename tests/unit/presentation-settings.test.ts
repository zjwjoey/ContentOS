import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRESENTATION_SETTINGS_V1, canvasForAspectRatio, normalizePresentationSettings, validatePresentationSettings } from '../../packages/contracts/src/index.js';
import { applyPresentationSettings, buildRandomSentenceMontageManifest, buildScriptMontageManifest, segmentScriptSentences } from '../../packages/modules/video/src/index.js';

test('presentation defaults and aspect presets are valid', () => {
  validatePresentationSettings(DEFAULT_PRESENTATION_SETTINGS_V1);
  assert.deepEqual(canvasForAspectRatio('16:9', 1920).height, 1080);
  assert.deepEqual(canvasForAspectRatio('1:1', 1080).height, 1080);
});

test('presentation positions are normalized and legacy defaults survive', () => {
  const value = normalizePresentationSettings({ subtitleStyle: { position: { x: 9, y: -1 } } as never });
  assert.equal(value.subtitleStyle.position.x, 1);
  assert.equal(value.subtitleStyle.position.y, 0);
  assert.equal(value.canvas.width, 1080);
  assert.equal(value.output.videoCodec, 'h264');
  assert.equal(value.segmentation.version, 'SCRIPT_SEGMENTATION_V1');
  assert.equal(value.subtitleStyle.animationDurationMs, 250);
});

test('script and mix presentation paths share the same compiler', () => {
  const settings = { ...DEFAULT_PRESENTATION_SETTINGS_V1, canvas: canvasForAspectRatio('16:9', 1920) };
  const assets = [{ id: 'a', storageKey: 'a', sourcePath: 'a.mp4', durationMs: 5_000 }];
  const script = buildScriptMontageManifest({ projectId: 'p-script', script: '甲。', sentences: segmentScriptSentences('甲。'), assets, seed: 1 });
  const mix = buildRandomSentenceMontageManifest({ projectId: 'p-mix', sentences: segmentScriptSentences('甲。'), assets, seed: 1 });
  assert.deepEqual(applyPresentationSettings(script.manifest, settings).canvas, applyPresentationSettings(mix.manifest, settings).canvas);
  assert.equal(applyPresentationSettings(script.manifest, settings).presentationSettings?.canvas.aspectRatio, '16:9');
});
