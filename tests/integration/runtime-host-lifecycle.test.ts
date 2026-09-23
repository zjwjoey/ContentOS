import { mkdtemp, rm, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHost } from '../../apps/runtime-host/src/host.js';
import { isPortOpen, isProcessAlive, ProcessManager, RuntimeStateStore, resolveRuntimePaths, type DoctorReport, type ServiceDefinition } from '../../packages/runtime-core/src/index.js';

const doctor: DoctorReport = { generatedAt: new Date().toISOString(), checks: [], coreStartup: 'READY' };
const fakeDoctor = async (): Promise<DoctorReport> => doctor;
const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolveWait) => setTimeout(resolveWait, 25)); } assert.equal(predicate(), true); };
const definition = (script: string, overrides: Partial<ServiceDefinition> = {}): ServiceDefinition => ({ id: 'sample', label: 'Sample', kind: 'PROCESS', required: true, dependsOn: [], startupTimeoutMs: 2_000, shutdownTimeoutMs: 1_000, restartClass: 'TRANSIENT', restartPolicy: { enabled: true, maxRestarts: 3, windowMs: 60_000, backoffMs: [50, 50, 50] }, command: process.execPath, args: ['-e', script], readiness: 'PROCESS', ...overrides });
const hostOptions = (root: string, port: number, service: ServiceDefinition, extraEnv: Record<string, string | undefined> = {}) => ({ env: { CONTENTOS_APP_ROOT: process.cwd(), CONTENTOS_RUNTIME_ROOT: join(root, 'runtime'), STORAGE_ROOT: join(root, 'storage'), DATABASE_URL: 'postgresql://unused', CONTENTOS_RUNTIME_CONTROL_PORT: String(port), PORT: String(port + 1), WEB_PORT: String(port + 2), ...extraEnv }, serviceDefinitions: [service], doctor: fakeDoctor });
const budgetCount = (host: RuntimeHost, id = 'sample') => ((host as unknown as { budgets: Map<string, { count: () => number }> }).budgets.get(id)?.count() || 0);

test('manual service restart has one start and does not consume crash budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-manual-restart-')); const host = new RuntimeHost(hostOptions(root, 3601, definition('setInterval(()=>{},1000);')));
  try { await host.start(); const before = host.status().services[0]?.pid; const result = await host.restartService('sample'); const after = host.status().services[0]?.pid; assert.equal(result.ok, true); assert.notEqual(after, before); assert.equal(budgetCount(host), 0); await new Promise((resolveWait) => setTimeout(resolveWait, 150)); assert.equal(host.status().services[0]?.restartCount, 0); } finally { await host.stop('test').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('health restart is scheduled once and consumes one restart budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-health-restart-')); let healthy = true;
  const service = definition('setInterval(()=>{},1000);', { healthFailureThreshold: 1, healthCheck: async () => healthy ? { state: 'READY' as const } : { state: 'FAILED' as const, message: 'synthetic health failure' } });
  const host = new RuntimeHost(hostOptions(root, 3611, service));
  try { await host.start(); const before = host.status().services[0]?.pid; healthy = false; await (host as unknown as { refreshHealth: () => Promise<void> }).refreshHealth(); assert.equal(budgetCount(host), 1); healthy = true; await waitFor(() => host.status().services[0]?.state === 'READY'); const after = host.status().services[0]?.pid; assert.notEqual(after, before); assert.equal(budgetCount(host), 1); } finally { await host.stop('test').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('genuine crash restarts and eventually exhausts the bounded budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-crash-restart-')); const host = new RuntimeHost(hostOptions(root, 3621, definition('setTimeout(()=>process.exit(1),60);')));
  try { await host.start(); await waitFor(() => budgetCount(host) >= 1); const firstBudget = budgetCount(host); await waitFor(() => host.status().state === 'FAILED', 4_000); assert.equal(firstBudget <= 3, true); assert.equal(budgetCount(host), 3); assert.equal(host.status().services[0]?.state, 'FAILED'); } finally { await host.stop('test').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('concurrent RuntimeHost starts produce one owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-concurrent-start-')); const service = definition('setInterval(()=>{},1000);'); const first = new RuntimeHost(hostOptions(root, 3631, service)); const second = new RuntimeHost(hostOptions(root, 3631, service));
  let winner: RuntimeHost | undefined;
  try { const results = await Promise.allSettled([first.start(), second.start()]); assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1); winner = results[0]?.status === 'fulfilled' ? first : second; const fulfilled = results.find((result) => result.status === 'fulfilled'); assert.ok(fulfilled); const failures = results.filter((result) => result.status === 'rejected').map((result) => String((result as PromiseRejectedResult).reason?.code || '')); assert.ok(failures.some((code) => code === 'RUNTIME_ALREADY_STARTING' || code === 'RUNTIME_ALREADY_RUNNING' || code === 'RUNTIME_LOCK_EXISTS')); } finally { await winner?.stop('test').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('startup Doctor failure removes state, lock and failure-owned resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-doctor-failure-')); const port = 3641; const service = definition('setInterval(()=>{},1000);'); const failedDoctor = async (): Promise<DoctorReport> => ({ generatedAt: new Date().toISOString(), checks: [{ id: 'database', scope: 'CORE', status: 'FAIL', message: 'synthetic doctor failure' }], coreStartup: 'NOT_READY' }); const host = new RuntimeHost({ ...hostOptions(root, port, service), doctor: failedDoctor });
  try { await assert.rejects(() => host.start(), (error: unknown) => (error as { code?: string }).code === 'CORE_STARTUP_FAILED'); const store = new RuntimeStateStore(resolveRuntimePaths({ CONTENTOS_APP_ROOT: process.cwd(), CONTENTOS_RUNTIME_ROOT: join(root, 'runtime') })); assert.equal(await store.read(), null); assert.equal(await store.readLock(), null); assert.equal(await isPortOpen(port), false); await access(join(root, 'runtime', 'startup-reports', `${host.instanceId}.failed.json`)); } finally { await host.stop('test').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('startup cancellation by stop has one teardown owner across 10 acquired-lock races', async () => {
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const root = await mkdtemp(join(tmpdir(), `contentos-start-stop-doctor-${iteration}-`));
    const port = 3701 + iteration;
    let doctorEntered!: () => void;
    let releaseDoctor!: () => void;
    const entered = new Promise<void>((resolveEntered) => { doctorEntered = resolveEntered; });
    const gate = new Promise<void>((resolveGate) => { releaseDoctor = resolveGate; });
    const blockingDoctor = async (): Promise<DoctorReport> => {
      doctorEntered();
      await gate;
      return doctor;
    };
    const host = new RuntimeHost({ ...hostOptions(root, port, definition('setInterval(()=>{},1000);')), doctor: blockingDoctor });
    try {
      const starting = host.start();
      await entered;
      assert.equal((await host.store.read())?.state, 'STARTING');
      const lock = await host.store.readLock();
      assert.equal(lock?.instanceId, host.instanceId);
      assert.equal(lock?.hostPid, process.pid);

      const stopping = host.stop(`startup-doctor-race-${iteration}`);
      releaseDoctor();
      const [startResult, stopResult] = await Promise.allSettled([starting, stopping]);
      assert.equal(startResult.status, 'rejected');
      assert.equal((startResult as PromiseRejectedResult).reason?.code, 'RUNTIME_START_CANCELLED');
      assert.equal(stopResult.status, 'fulfilled');
      assert.equal((stopResult as PromiseFulfilledResult<{ ok: boolean }>).value.ok, true);

      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      assert.equal(await host.store.read(), null);
      assert.equal(await host.store.readLock(), null);
      assert.equal(await isPortOpen(port), false);
      assert.equal(host.status().services.every((service) => !service.pid || !isProcessAlive(service.pid)), true);
    } finally {
      releaseDoctor();
      await host.stop('test').catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('stop during blocked service readiness owns teardown and kills the started child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-start-stop-readiness-'));
  const port = 3711;
  let healthEntered!: () => void;
  let releaseHealth!: () => void;
  const entered = new Promise<void>((resolveEntered) => { healthEntered = resolveEntered; });
  const gate = new Promise<void>((resolveGate) => { releaseHealth = resolveGate; });
  const service = definition('setInterval(()=>{},1000);', { healthCheck: async () => { healthEntered(); await gate; return { state: 'READY' as const }; } });
  const host = new RuntimeHost(hostOptions(root, port, service));
  try {
    const starting = host.start();
    await entered;
    assert.equal((await host.store.read())?.state, 'STARTING');
    const pid = host.status().services[0]?.pid;
    assert.ok(pid);
    assert.equal(isProcessAlive(pid), true);

    const stopping = host.stop('startup-readiness-race');
    releaseHealth();
    const [startResult, stopResult] = await Promise.allSettled([starting, stopping]);
    assert.equal(startResult.status, 'rejected');
    assert.equal((startResult as PromiseRejectedResult).reason?.code, 'RUNTIME_START_CANCELLED');
    assert.equal(stopResult.status, 'fulfilled');
    assert.equal((stopResult as PromiseFulfilledResult<{ ok: boolean }>).value.ok, true);

    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    assert.equal(await host.store.read(), null);
    assert.equal(await host.store.readLock(), null);
    assert.equal(await isPortOpen(port), false);
    assert.equal(isProcessAlive(pid), false);
  } finally {
    releaseHealth();
    await host.stop('test').catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('control port conflict fails before lock/state acquisition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-control-conflict-')); const port = 3651; const server = createServer((_request, response) => response.end('{}')); await new Promise<void>((resolveListen) => server.listen(port, '127.0.0.1', resolveListen)); const host = new RuntimeHost(hostOptions(root, port, definition('setInterval(()=>{},1000);')));
  try { await assert.rejects(() => host.start(), (error: unknown) => (error as { code?: string }).code === 'RUNTIME_CONTROL_PORT_CONFLICT'); const store = new RuntimeStateStore(resolveRuntimePaths({ CONTENTOS_APP_ROOT: process.cwd(), CONTENTOS_RUNTIME_ROOT: join(root, 'runtime') })); assert.equal(await store.read(), null); assert.equal(await store.readLock(), null); } finally { server.closeAllConnections?.(); await new Promise<void>((resolveClose) => server.close(() => resolveClose())); await host.stop('test').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('shutdown invalidates an in-flight health pass before it can recreate runtime state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-health-shutdown-race-'));
  let blockHealth = false; let healthCalls = 0; let healthEntered!: () => void; let releaseHealth!: () => void;
  const entered = new Promise<void>((resolveEntered) => { healthEntered = resolveEntered; });
  const healthGate = new Promise<void>((resolveGate) => { releaseHealth = resolveGate; });
  const service = definition('setInterval(()=>{},1000);', { healthCheck: async () => { if (blockHealth) { healthCalls += 1; healthEntered(); await healthGate; } return { state: 'READY' as const }; } });
  const host = new RuntimeHost(hostOptions(root, 3661, service));
  let shutdownCompleted = false; let writesAfterShutdown = 0;
  const originalWrite = host.store.write.bind(host.store);
  (host.store as unknown as { write: RuntimeStateStore['write'] }).write = async (state) => { if (shutdownCompleted) writesAfterShutdown += 1; await originalWrite(state); };
  try {
    await host.start();
    const pid = host.status().services[0]?.pid;
    blockHealth = true;
    const pass = (host as unknown as { refreshHealth: () => Promise<void> }).refreshHealth();
    await entered;
    const overlappingPass = (host as unknown as { refreshHealth: () => Promise<void> }).refreshHealth();
    assert.equal(healthCalls, 1);
    const stopping = host.stop('health-race');
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    releaseHealth();
    await stopping;
    shutdownCompleted = true;
    await pass;
    await overlappingPass;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    assert.equal(await host.store.read(), null);
    assert.equal(await host.store.readLock(), null);
    assert.equal(pid ? isProcessAlive(pid) : false, false);
    assert.equal(writesAfterShutdown, 0);
    assert.equal((host as unknown as { healthPass?: Promise<void> }).healthPass, undefined);
  } finally { releaseHealth(); await host.stop('test').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('shutdown cancels or drains restart callbacks across 20 start/stop cycles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-restart-shutdown-race-'));
  const service = definition('setInterval(()=>{},1000);');
  const host = new RuntimeHost(hostOptions(root, 3671, service));
  const restart = host as unknown as { scheduleRestart: (definition: ServiceDefinition, delay: number, generation?: number) => void; restartTimers: Map<string, NodeJS.Timeout>; restartTasks: Set<Promise<void>>; processes: ProcessManager };
  const startedPids: number[] = [];
  const originalStart = restart.processes.start.bind(restart.processes);
  restart.processes.start = async (...args) => { const child = await originalStart(...args); if (child.pid) startedPids.push(child.pid); return child; };
  try {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      await host.start();
      restart.scheduleRestart(service, 0);
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
      await host.stop(`restart-race-${iteration}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      assert.equal(restart.restartTimers.size, 0);
      assert.equal(restart.restartTasks.size, 0);
      assert.equal(await host.store.read(), null);
      assert.equal(await host.store.readLock(), null);
      assert.equal(restart.processes.get('sample'), undefined);
      assert.equal(startedPids.every((pid) => !isProcessAlive(pid)), true);
      assert.equal(budgetCount(host), 0);
      assert.equal(host.status().services[0]?.state, 'STOPPED');
    }
  } finally { await host.stop('test').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('persist queue keeps final READY state after STARTING and READY writes overlap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-persist-order-'));
  const host = new RuntimeHost(hostOptions(root, 3681, definition('setInterval(()=>{},1000);')));
  let releaseWrite!: () => void; let enteredWrite!: () => void;
  const gate = new Promise<void>((resolveGate) => { releaseWrite = resolveGate; });
  const entered = new Promise<void>((resolveEntered) => { enteredWrite = resolveEntered; });
  const originalWrite = host.store.write.bind(host.store); const writtenStates: string[] = [];
  (host.store as unknown as { write: RuntimeStateStore['write'] }).write = async (state) => {
    writtenStates.push(state.state);
    if (state.state === 'STARTING') { enteredWrite(); await gate; }
    await originalWrite(state);
  };
  try {
    const persist = host as unknown as { persist: (state: 'STARTING' | 'READY') => Promise<void> };
    const starting = persist.persist('STARTING');
    await entered;
    const ready = persist.persist('READY');
    releaseWrite();
    await Promise.all([starting, ready]);
    assert.deepEqual(writtenStates, ['STARTING', 'READY']);
    assert.equal((await host.store.read())?.state, 'READY');
  } finally { releaseWrite(); await rm(root, { recursive: true, force: true }); }
});

test('old lifecycle child exit cannot mutate the next RuntimeHost lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-old-exit-generation-'));
  const host = new RuntimeHost(hostOptions(root, 3691, definition('setInterval(()=>{},1000);')));
  const internals = host as unknown as { processes: { get: (id: string) => { child: NodeJS.EventEmitter } | undefined }; budgets: Map<string, { count: () => number }> };
  try {
    await host.start();
    const oldChild = internals.processes.get('sample')?.child;
    assert.ok(oldChild);
    const oldExit = oldChild.listeners('exit').at(-1) as ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    assert.ok(oldExit);
    await host.stop('first-lifecycle');
    const next = await host.start();
    const nextState = await host.store.read();
    const budgetBefore = budgetCount(host);
    oldExit.call(oldChild, 1, null);
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    assert.equal(host.status().instanceId, next.instanceId);
    assert.equal(host.status().services[0]?.state, 'READY');
    assert.equal(budgetCount(host), budgetBefore);
    assert.equal((await host.store.read())?.instanceId, nextState?.instanceId);
  } finally { await host.stop('test').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
