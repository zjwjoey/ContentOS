import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RestartBudget, RuntimeStateStore, ServiceRegistry, resolveRuntimeConfig, resolveRuntimePaths } from '../../packages/runtime-core/src/index.js';

test('service registry resolves dependencies and rejects cycles', () => {
  const registry = new ServiceRegistry();
  registry.register({ id: 'db', label: 'DB', kind: 'EXTERNAL', required: true, dependsOn: [], startupTimeoutMs: 1, shutdownTimeoutMs: 1, restartPolicy: { enabled: false, maxRestarts: 0, windowMs: 1, backoffMs: [] } });
  registry.register({ id: 'api', label: 'API', kind: 'PROCESS', required: true, dependsOn: ['db'], startupTimeoutMs: 1, shutdownTimeoutMs: 1, restartPolicy: { enabled: false, maxRestarts: 0, windowMs: 1, backoffMs: [] } });
  assert.deepEqual(registry.topological().map((item) => item.id), ['db', 'api']);
  const cycle = new ServiceRegistry();
  cycle.register({ id: 'a', label: 'A', kind: 'TASK', required: true, dependsOn: ['b'], startupTimeoutMs: 1, shutdownTimeoutMs: 1, restartPolicy: { enabled: false, maxRestarts: 0, windowMs: 1, backoffMs: [] } });
  cycle.register({ id: 'b', label: 'B', kind: 'TASK', required: true, dependsOn: ['a'], startupTimeoutMs: 1, shutdownTimeoutMs: 1, restartPolicy: { enabled: false, maxRestarts: 0, windowMs: 1, backoffMs: [] } });
  assert.throws(() => cycle.topological(), /SERVICE_DEPENDENCY_CYCLE/);
});

test('service registry rejects unknown and safe-mode unavailable dependencies', () => {
  const missing = new ServiceRegistry();
  missing.register({ id: 'api', label: 'API', kind: 'PROCESS', required: true, dependsOn: ['database'], startupTimeoutMs: 1, shutdownTimeoutMs: 1, restartPolicy: { enabled: false, maxRestarts: 0, windowMs: 1, backoffMs: [] } });
  assert.throws(() => missing.topological(), /SERVICE_DEPENDENCY_MISSING:database/);
  const safe = new ServiceRegistry();
  safe.register({ id: 'optional', label: 'Optional', kind: 'PROCESS', required: false, dependsOn: [], startupTimeoutMs: 1, shutdownTimeoutMs: 1, restartPolicy: { enabled: false, maxRestarts: 0, windowMs: 1, backoffMs: [] } });
  safe.register({ id: 'core', label: 'Core', kind: 'PROCESS', required: true, dependsOn: ['optional'], startupTimeoutMs: 1, shutdownTimeoutMs: 1, restartPolicy: { enabled: false, maxRestarts: 0, windowMs: 1, backoffMs: [] } });
  assert.throws(() => safe.topological(false), /SERVICE_DEPENDENCY_UNAVAILABLE:core:optional/);
});

test('runtime config is the single source for roots, ports, database and launch mode', () => {
  const config = resolveRuntimeConfig({ CONTENTOS_APP_ROOT: 'C:\\ContentOS', CONTENTOS_RUNTIME_ROOT: 'runtime-data', STORAGE_ROOT: 'media', DATABASE_URL: 'postgresql://example', PORT: '3010', WEB_PORT: '3011', CONTENTOS_RUNTIME_CONTROL_PORT: '3019', CONTENTOS_RUNTIME_MODE: 'PACKAGED' });
  assert.equal(config.appRoot, 'C:\\ContentOS');
  assert.equal(config.apiPort, 3010); assert.equal(config.webPort, 3011); assert.equal(config.controlPort, 3019); assert.equal(config.databaseUrl, 'postgresql://example'); assert.equal(config.launchMode, 'PACKAGED');
});

test('restart budget enforces bounded retries and expires old events', () => {
  const budget = new RestartBudget({ enabled: true, maxRestarts: 3, windowMs: 100, backoffMs: [10, 20, 30] });
  assert.equal(budget.canRestart(1_000), true);
  assert.equal(budget.consume(1_000), 10);
  assert.equal(budget.consume(1_010), 20);
  assert.equal(budget.consume(1_020), 30);
  assert.equal(budget.canRestart(1_030), false);
  assert.equal(budget.canRestart(1_101), true);
});

test('runtime state store writes atomically and acquires a single instance lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-runtime-'));
  try {
    const paths = resolveRuntimePaths({ CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime') });
    const store = new RuntimeStateStore(paths);
    const state = { instanceId: 'test', hostPid: process.pid, startedAt: new Date().toISOString(), controlPort: 3999, controlToken: 'token', state: 'STARTING' as const, services: [], warnings: [] };
    await store.write(state);
    assert.deepEqual(await store.read(), state);
    await store.acquire({ instanceId: 'test', hostPid: process.pid });
    await assert.rejects(() => store.acquire({ instanceId: 'other', hostPid: process.pid }), /RUNTIME_LOCK_EXISTS/);
    await store.remove();
    assert.equal(await store.read(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
