import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHost } from '../../apps/runtime-host/src/host.js';
import { RuntimeStateStore, resolveRuntimePaths } from '../../packages/runtime-core/src/index.js';
import { RuntimeClient } from '../../packages/runtime-client/src/index.js';

test('runtime host starts real core services, reports readiness, and shuts down', { timeout: 120_000 }, async (t) => {
  if (process.env.CONTENTOS_RUNTIME_INTEGRATION !== '1') { t.skip('set CONTENTOS_RUNTIME_INTEGRATION=1 to run the real process integration'); return; }
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const runtimeRoot = await mkdtemp(resolve(tmpdir(), 'contentos-runtime-host-'));
  const env = { ...process.env, CONTENTOS_APP_ROOT: appRoot, CONTENTOS_RUNTIME_ROOT: runtimeRoot, STORAGE_ROOT: resolve(appRoot, 'storage', 'local'), DATABASE_URL: process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_operator_dev', PORT: '3200', WEB_PORT: '3201', CONTENTOS_RUNTIME_CONTROL_PORT: '3299' };
  const store = new RuntimeStateStore(resolveRuntimePaths(env));
  await store.write({ instanceId: 'stale', hostPid: 999999, startedAt: new Date().toISOString(), controlPort: 3299, controlToken: 'stale-token', state: 'STARTING', services: [], warnings: [] });
  await store.acquire({ instanceId: 'stale', hostPid: 999999 });
  const host = new RuntimeHost({ env, safeMode: true });
  try {
    const status = await host.start();
    assert.ok(['READY', 'READY_WITH_WARNINGS'].includes(status.state));
    assert.equal(status.services.find((item) => item.id === 'api')?.state, 'READY');
    assert.equal(status.services.find((item) => item.id === 'web')?.state, 'READY');
    assert.equal((await new RuntimeClient({ env }).start()).instanceId, status.instanceId);
    const unauthorized = await fetch('http://127.0.0.1:3299/runtime/stop', { method: 'POST', headers: { authorization: 'Bearer invalid-token' } });
    assert.equal(unauthorized.status, 401);
  } finally {
    await host.stop('TEST');
    assert.equal(await store.read(), null);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
