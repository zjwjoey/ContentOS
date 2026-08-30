import test from 'node:test';
import assert from 'node:assert/strict';
import { WeChatChannelsPlaywrightAdapter } from '../../packages/modules/publisher/src/wechat-channels-playwright-adapter.js';
import type { BrowserPage, BrowserSessionFactory } from '../../packages/modules/publisher/src/browser-session.js';
import type { PublishSnapshot, PublisherContext } from '../../packages/contracts/src/index.js';

test('WeChat Channels adapter uses the configured page URL and selector profile', async () => {
  const calls: string[] = [];
  const page: BrowserPage = {
    goto: async (url) => { calls.push(`goto:${url}`); },
    isVisible: async (selector) => { calls.push(`visible:${selector}`); return selector === '[data-test="upload-file"]' || selector === '[data-test="description"]'; },
    setInputFiles: async (selector, filePath) => { calls.push(`file:${selector}:${filePath}`); },
    fill: async (selector, value) => { calls.push(`fill:${selector}:${value}`); },
    click: async (selector) => { calls.push(`click:${selector}`); },
    waitFor: async (selector) => { calls.push(`wait:${selector}`); },
    screenshot: async (path) => { calls.push(`screenshot:${path}`); },
  };
  const factory: BrowserSessionFactory = { open: async (input) => ({ profileDir: input.profileDir, page: async () => page, close: async () => undefined }) };
  const context: PublisherContext = { profileDir: 'profile', accountId: 'wechat-account', credentialRef: 'profile://wechat' };
  const snapshot: PublishSnapshot = { requestId: 'r', idempotencyKey: 'k', assetId: 'a', mediaPath: 'video.mp4', title: 'title', description: 'description' };
  const result = await new WeChatChannelsPlaywrightAdapter(factory, { allowSubmit: false, selectorProfile: { loginMarker: '[data-test="login"]', verificationMarker: '[data-test="verify"]', fileInput: '[data-test="upload-file"]', descriptionInput: '[data-test="description"]', coverInput: '[data-test="cover-file"]', publishButton: '[data-test="publish"]', successMarker: '[data-test="success"]' } }).publish(context, snapshot);
  assert.equal(result.failure?.code, 'REQUIRES_VERIFICATION');
  assert.equal(calls[0], 'goto:https://channels.weixin.qq.com/platform/post/create');
  assert.equal(calls.some((call) => call === 'file:[data-test="upload-file"]:video.mp4'), true);
});
