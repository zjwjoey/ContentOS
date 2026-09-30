import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopRuntimeManager } from '../../apps/desktop/src/main/runtime-manager.js';

test('Desktop Runtime Manager starts with a safe serializable snapshot', () => {
  const manager = new DesktopRuntimeManager({ CONTENTOS_RUNTIME_ROOT: 'runtime/test-desktop-manager' });
  const snapshot = manager.snapshot();
  assert.equal(snapshot.apiVersion, 1);
  assert.equal(snapshot.phase, 'STOPPED');
  assert.equal(snapshot.status, null);
  assert.equal(snapshot.error, null);
  assert.match(snapshot.logRoot, /runtime[\\/]test-desktop-manager[\\/]logs$/);
});

test('Desktop Runtime Manager derives the Web URL from the shared runtime config', () => {
  const manager = new DesktopRuntimeManager({ WEB_PORT: '3311' });
  assert.equal(manager.webUrl(), 'http://127.0.0.1:3311');
});
