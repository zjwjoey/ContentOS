import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
  const root = join(tmpdir(), 'contentos-runtime-config');
  const config = resolveRuntimeConfig({ CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime-data'), STORAGE_ROOT: join(root, 'media'), DATABASE_URL: 'postgresql://example', PORT: '3010', WEB_PORT: '3011', CONTENTOS_RUNTIME_CONTROL_PORT: '3019', CONTENTOS_RUNTIME_MODE: 'PACKAGED' });
  assert.equal(config.appRoot, root);
  assert.equal(config.apiPort, 3010); assert.equal(config.webPort, 3011); assert.equal(config.controlPort, 3019); assert.equal(config.databaseUrl, 'postgresql://example'); assert.equal(config.launchMode, 'PACKAGED');
});

test('stale lock compare-and-delete never removes a replacement lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-stale-race-'));
  try {
    const store = new RuntimeStateStore(resolveRuntimePaths({ CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime') }));
    const state = { instanceId: 'old', hostPid: 999999, startedAt: new Date().toISOString(), controlPort: 3998, controlToken: 'token', state: 'FAILED' as const, services: [], warnings: [] };
    await store.write(state); await store.acquire({ instanceId: 'old', hostPid: 999999, controlPort: 3998 });
    const oldLock = await store.readLock(); assert.ok(oldLock);
    await rm(store.lockPath, { force: true }); await store.acquire({ instanceId: 'new', hostPid: process.pid, controlPort: 3998 });
    assert.equal(await store.claimStale(oldLock, state), false);
    assert.equal((await store.readLock())?.instanceId, 'new');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale cleanup transaction cannot delete a replacement state written by a racing acquirer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-stale-state-transaction-'));
  try {
    const store = new RuntimeStateStore(resolveRuntimePaths({ CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime') }));
    const oldOwner = { instanceId: 'old', hostPid: 999999, controlPort: 3988 };
    const newOwner = { instanceId: 'new', hostPid: process.pid, controlPort: 3988 };
    const makeState = (owner: typeof oldOwner) => ({ ...owner, startedAt: new Date().toISOString(), controlToken: `${owner.instanceId}-token`, state: 'FAILED' as const, services: [], warnings: [] });
    await store.write(makeState(oldOwner)); await store.acquire(oldOwner);
    const oldLock = await store.readLock(); const oldState = await store.read(); assert.ok(oldLock && oldState);

    const originalWait = (store as unknown as { waitForCleanup: () => Promise<void> }).waitForCleanup.bind(store);
    let releaseAcquirer!: () => void; let signalPassedInitialCheck!: () => void;
    const acquirerGate = new Promise<void>((resolveGate) => { releaseAcquirer = resolveGate; });
    const passedInitialCheck = new Promise<void>((resolveSignal) => { signalPassedInitialCheck = resolveSignal; });
    let pauseOnce = true;
    (store as unknown as { waitForCleanup: () => Promise<void> }).waitForCleanup = async () => {
      await originalWait();
      if (pauseOnce) { pauseOnce = false; signalPassedInitialCheck(); await acquirerGate; }
    };
    const acquireNew = store.acquire(newOwner);
    await passedInitialCheck;

    const originalRead = store.read.bind(store);
    let releaseCleaner!: () => void; let signalCleanerRead!: () => void;
    const cleanerGate = new Promise<void>((resolveGate) => { releaseCleaner = resolveGate; });
    const cleanerReadStarted = new Promise<void>((resolveSignal) => { signalCleanerRead = resolveSignal; });
    (store as unknown as { read: () => Promise<Awaited<ReturnType<RuntimeStateStore['read']>>> }).read = async () => {
      signalCleanerRead();
      await cleanerGate;
      return originalRead();
    };
    const cleanup = store.claimStale(oldLock, oldState);
    await cleanerReadStarted;
    releaseAcquirer();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    releaseCleaner();
    assert.equal(await cleanup, true);
    (store as unknown as { read: RuntimeStateStore['read'] }).read = originalRead;
    await acquireNew;
    await store.write(makeState(newOwner));
    assert.equal((await store.readLock())?.instanceId, newOwner.instanceId);
    assert.equal((await store.read())?.instanceId, newOwner.instanceId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale cleanup and replacement acquisition preserve ownership across 30 interleavings', async () => {
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const root = await mkdtemp(join(tmpdir(), `contentos-stale-stress-${iteration}-`));
    try {
      const store = new RuntimeStateStore(resolveRuntimePaths({ CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime') }));
      const oldOwner = { instanceId: `old-${iteration}`, hostPid: 999999, controlPort: 3987 };
      const newOwner = { instanceId: `new-${iteration}`, hostPid: process.pid, controlPort: 3987 };
      const makeState = (owner: typeof oldOwner) => ({ ...owner, startedAt: new Date().toISOString(), controlToken: 'token', state: 'FAILED' as const, services: [], warnings: [] });
      await store.write(makeState(oldOwner)); await store.acquire(oldOwner);
      const oldLock = await store.readLock(); const oldState = await store.read(); assert.ok(oldLock && oldState);
      const cleanup = store.claimStale(oldLock, oldState);
      const acquire = (async () => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try { await store.acquire(newOwner); return; }
          catch (error) { if (!['RUNTIME_LOCK_EXISTS', 'RUNTIME_CLEANUP_IN_PROGRESS'].includes(String((error as { code?: string }).code))) throw error; await new Promise((resolveWait) => setTimeout(resolveWait, 2)); }
        }
        assert.fail('replacement owner could not acquire after stale cleanup');
      })();
      await Promise.all([cleanup, acquire]);
      await store.write(makeState(newOwner));
      const [lock, state] = await Promise.all([store.readLock(), store.read()]);
      assert.equal(lock?.instanceId, newOwner.instanceId); assert.equal(state?.instanceId, newOwner.instanceId);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('removeOwned preserves replacement lock and state after ownership changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-remove-owned-'));
  try {
    const store = new RuntimeStateStore(resolveRuntimePaths({ CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime') }));
    const newOwner = { instanceId: 'new-owner', hostPid: process.pid, controlPort: 3985 };
    const state = { ...newOwner, startedAt: new Date().toISOString(), controlToken: 'token', state: 'READY' as const, services: [], warnings: [] };
    await store.acquire(newOwner); await store.write(state);
    assert.equal(await store.removeOwned({ instanceId: 'old-owner', hostPid: 999999, controlPort: 3985 }), false);
    assert.equal((await store.readLock())?.instanceId, newOwner.instanceId);
    assert.equal((await store.read())?.instanceId, newOwner.instanceId);
  } finally { await rm(root, { recursive: true, force: true }); }
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
    await store.acquire({ instanceId: 'test', hostPid: process.pid, controlPort: 3999 });
    await assert.rejects(() => store.acquire({ instanceId: 'other', hostPid: process.pid, controlPort: 3999 }), /RUNTIME_LOCK_EXISTS/);
    await store.remove();
    assert.equal(await store.read(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime state store supports 50 concurrent unique temporary writes without leftovers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-runtime-write-race-'));
  try {
    const runtimeRoot = join(root, 'runtime');
    const paths = resolveRuntimePaths({ CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: runtimeRoot });
    const store = new RuntimeStateStore(paths);
    const writes = Array.from({ length: 50 }, (_, index) => store.write({ instanceId: `write-${index}`, hostPid: process.pid, startedAt: new Date().toISOString(), controlPort: 3986, controlToken: 'token', state: 'READY', services: [], warnings: [`write-${index}`] }));
    await Promise.all(writes);
    const stored = await store.read();
    assert.ok(stored);
    assert.match(stored.warnings[0] || '', /^write-(?:[0-9]|[1-4][0-9])/u);
    const stateFiles = await readdir(paths.stateRoot);
    assert.equal(stateFiles.some((name) => name.endsWith('.tmp')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
