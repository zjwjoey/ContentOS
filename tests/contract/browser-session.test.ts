import test from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserSession, type BrowserSession, type BrowserSessionFactory } from '../../packages/modules/publisher/src/browser-session.js';

test('browser session helper opens an isolated profile and closes on success', async () => {
  const calls: string[] = [];
  const session: BrowserSession = { profileDir: 'profile-a', page: async () => ({}) as never, close: async () => { calls.push('close'); } };
  const factory: BrowserSessionFactory = { open: async (input) => { calls.push(`${input.profileDir}:${input.headed}`); return session; } };
  const result = await withBrowserSession(factory, { profileDir: 'profile-a', headed: true }, async (active) => active.profileDir);
  assert.equal(result, 'profile-a');
  assert.deepEqual(calls, ['profile-a:true', 'close']);
});

test('browser session helper closes the session when the adapter operation fails', async () => {
  let closed = false;
  const factory: BrowserSessionFactory = { open: async () => ({ profileDir: 'profile-b', page: async () => ({}) as never, close: async () => { closed = true; } }) };
  await assert.rejects(() => withBrowserSession(factory, { profileDir: 'profile-b', headed: false }, async () => { throw new Error('page failed'); }), /page failed/);
  assert.equal(closed, true);
});
