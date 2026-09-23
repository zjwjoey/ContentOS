import { mkdtemp, rm, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHost } from '../../apps/runtime-host/src/host.js';
import { isPortOpen, RuntimeStateStore, resolveRuntimePaths, type DoctorReport, type ServiceDefinition } from '../../packages/runtime-core/src/index.js';

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

test('control port conflict fails before lock/state acquisition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-control-conflict-')); const port = 3651; const server = createServer((_request, response) => response.end('{}')); await new Promise<void>((resolveListen) => server.listen(port, '127.0.0.1', resolveListen)); const host = new RuntimeHost(hostOptions(root, port, definition('setInterval(()=>{},1000);')));
  try { await assert.rejects(() => host.start(), (error: unknown) => (error as { code?: string }).code === 'RUNTIME_CONTROL_PORT_CONFLICT'); const store = new RuntimeStateStore(resolveRuntimePaths({ CONTENTOS_APP_ROOT: process.cwd(), CONTENTOS_RUNTIME_ROOT: join(root, 'runtime') })); assert.equal(await store.read(), null); assert.equal(await store.readLock(), null); } finally { server.closeAllConnections?.(); await new Promise<void>((resolveClose) => server.close(() => resolveClose())); await host.stop('test').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
