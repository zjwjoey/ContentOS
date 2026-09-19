import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRESENTATION_SETTINGS_V1, canvasForAspectRatio, normalizePresentationSettings, validatePresentationSettings } from '../../packages/contracts/src/index.js';

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
});
