import test from 'node:test';
import assert from 'node:assert/strict';
import { WeChatChannelsPlaywrightAdapter } from '../../packages/modules/publisher/src/wechat-channels-playwright-adapter.js';
import type { BrowserPage, BrowserSession, BrowserSessionFactory } from '../../packages/modules/publisher/src/browser-session.js';
import type { PublishSnapshot, PublisherContext } from '../../packages/contracts/src/index.js';

const context: PublisherContext = { profileDir: 'profile-wechat', accountId: 'wechat-account', credentialRef: 'profile://wechat/account' };
const snapshot: PublishSnapshot = { requestId: 'request-wechat', idempotencyKey: 'publish-wechat-1', assetId: 'asset-1', mediaPath: 'C:/tmp/video.mp4', title: '标题', description: '#话题' };

class FakePage implements BrowserPage {
  readonly calls: string[] = [];
  constructor(private readonly visible: Record<string, boolean>, private readonly success = true, private readonly visibleAfterWait: Record<string, boolean> = {}, private readonly textValues: Record<string, string> = {}) {}
  async goto(url: string): Promise<void> { this.calls.push(`goto:${url}`); }
  async isVisible(selector: string): Promise<boolean> { this.calls.push(`visible:${selector}`); return this.visible[selector] || false; }
  async setInputFiles(selector: string, filePath: string): Promise<void> { this.calls.push(`file:${selector}:${filePath}`); }
  async fill(selector: string, value: string): Promise<void> { this.calls.push(`fill:${selector}:${value}`); }
  async click(selector: string): Promise<void> { this.calls.push(`click:${selector}`); }
  async waitFor(selector: string): Promise<void> { this.calls.push(`wait:${selector}`); if (this.visibleAfterWait[selector]) this.visible[selector] = true; }
  async screenshot(path: string): Promise<void> { this.calls.push(`screenshot:${path}`); }
  async getAttribute(selector: string, name: string): Promise<string | null> { this.calls.push(`attribute:${selector}:${name}`); return name === 'data-post-id' ? this.textValues[selector] || null : null; }
  async textContent(selector: string): Promise<string | null> { this.calls.push(`text:${selector}`); return this.textValues[selector] || null; }
  isSuccess(): boolean { return this.success; }
}

function factoryFor(page: FakePage, opened: Array<{ profileDir: string; headed: boolean }>): BrowserSessionFactory {
  return { open: async (input) => { opened.push(input); return { profileDir: input.profileDir, page: async () => page, close: async () => { page.calls.push('close'); } }; } };
}

test('WeChat Channels maps expired login and verification to human-action failures', async () => {
  const loginPage = new FakePage({ 'text=登录': true });
  const adapter = new WeChatChannelsPlaywrightAdapter(factoryFor(loginPage, []), { headed: true });
  const login = await adapter.publish(context, snapshot);
  assert.equal(login.failure?.code, 'AUTH_EXPIRED');
  const verificationPage = new FakePage({ 'text=验证': true });
  const verification = await new WeChatChannelsPlaywrightAdapter(factoryFor(verificationPage, []), { headed: true }).publish(context, snapshot);
  assert.equal(verification.failure?.code, 'REQUIRES_VERIFICATION');
});

test('WeChat Channels fills content but stops before irreversible submit without confirmation', async () => {
  const page = new FakePage({ 'input[type="file"]': true, textarea: true, 'button:has-text("发表")': true });
  const adapter = new WeChatChannelsPlaywrightAdapter(factoryFor(page, []), { headed: true, allowSubmit: false });
  const result = await adapter.publish(context, snapshot);
  assert.equal(result.failure?.code, 'REQUIRES_VERIFICATION');
  assert.equal(page.calls.some((call) => call.startsWith('file:')), true);
  assert.equal(page.calls.some((call) => call.startsWith('fill:')), true);
  assert.equal(page.calls.some((call) => call.startsWith('click:')), false);
});

test('WeChat Channels normalizes DOM drift and uncertain submit with isolated profiles', async () => {
  const opened: Array<{ profileDir: string; headed: boolean }> = [];
  const driftPage = new FakePage({});
  const drift = await new WeChatChannelsPlaywrightAdapter(factoryFor(driftPage, opened), { headed: false, evidenceDir: 'evidence' }).publish({ ...context, profileDir: 'profile-a' }, snapshot);
  assert.equal(drift.failure?.code, 'PLATFORM_CHANGED');
  assert.equal(driftPage.calls.some((call) => call.startsWith('screenshot:')), true);
  const uncertainPage = new FakePage({ 'input[type="file"]': true, textarea: true, 'button:has-text("发表")': true }, false);
  const uncertain = await new WeChatChannelsPlaywrightAdapter(factoryFor(uncertainPage, opened), { headed: false, allowSubmit: true, evidenceDir: 'evidence' }).publish({ ...context, profileDir: 'profile-b' }, { ...snapshot, idempotencyKey: 'publish-wechat-uncertain' });
  assert.equal(uncertain.status, 'UNKNOWN_EXTERNAL_STATE');
  assert.deepEqual(opened.map((item) => item.profileDir), ['profile-a', 'profile-b']);
});

test('WeChat Channels waits for an asynchronous success marker after submit', async () => {
  const page = new FakePage({ 'input[type="file"]': true, textarea: true, 'button:has-text("发表")': true }, true, { 'text=发布成功': true }, { '[data-post-id]': 'wechat-post-1' });
  const result = await new WeChatChannelsPlaywrightAdapter(factoryFor(page, []), { headed: false, allowSubmit: true }).publish(context, { ...snapshot, idempotencyKey: 'publish-wechat-success' });
  assert.equal(result.status, 'PUBLISHED');
  assert.equal(result.externalPostId, 'wechat-post-1');
  assert.equal(page.calls.includes('wait:text=发布成功'), true);
  assert.equal(page.calls.includes('attribute:[data-post-id]:data-post-id'), true);
});

test('WeChat Channels never reports success without an external post id', async () => {
  const page = new FakePage({ 'input[type="file"]': true, textarea: true, 'button:has-text("发表")': true }, true, { 'text=发布成功': true });
  const adapter = new WeChatChannelsPlaywrightAdapter(factoryFor(page, []), { headed: false, allowSubmit: true });
  const result = await adapter.publish(context, { ...snapshot, idempotencyKey: 'publish-wechat-missing-id' });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.failure?.classification, 'HUMAN_ACTION_REQUIRED');
  const retry = await adapter.publish(context, { ...snapshot, idempotencyKey: 'publish-wechat-missing-id' });
  assert.equal(retry.status, 'UNKNOWN_EXTERNAL_STATE');
});

test('WeChat Channels normalizes browser failures before submission as retryable network errors', async () => {
  const browser: BrowserSessionFactory = { open: async () => { throw new Error('browser launch failed'); } };
  const result = await new WeChatChannelsPlaywrightAdapter(browser, { headed: false }).publish(context, snapshot);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.failure?.code, 'NETWORK_ERROR');
  assert.equal(result.failure?.classification, 'RETRYABLE');
});
