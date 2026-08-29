import test from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserSession, type BrowserSessionFactory } from '../../packages/modules/publisher/src/index.js';

test('browser session wrapper closes sessions after callback success and failure', async () => {
  let closes = 0;
  const factory: BrowserSessionFactory = { open: async () => ({ profileDir: 'profiles/account-a', page: async () => ({ goto: async () => {}, isVisible: async () => false, setInputFiles: async () => {}, fill: async () => {}, click: async () => {}, waitFor: async () => {}, screenshot: async () => {} }), close: async () => { closes += 1; } }) };
  await withBrowserSession(factory, { profileDir: 'profiles/account-a', headed: false }, async () => 'ok');
  await assert.rejects(() => withBrowserSession(factory, { profileDir: 'profiles/account-a', headed: false }, async () => { throw new Error('callback failed'); }));
  assert.equal(closes, 2);
});
