import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeClient } from '../../packages/runtime-client/src/index.js';
import { RuntimeStateStore, resolveRuntimePaths } from '../../packages/runtime-core/src/index.js';

test('RuntimeClient waits past control-port listening until runtime is READY', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-client-')); const port = 3399; const instanceId = 'test-instance';
  const env = { CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime'), STORAGE_ROOT: join(root, 'storage'), DATABASE_URL: 'postgresql://unused', CONTENTOS_RUNTIME_CONTROL_PORT: String(port) };
  const store = new RuntimeStateStore(resolveRuntimePaths(env)); const state = { instanceId, hostPid: process.pid, startedAt: new Date().toISOString(), controlPort: port, controlToken: 'token', state: 'STARTING' as const, services: [], warnings: [] }; await store.write(state); await store.acquire({ instanceId, hostPid: process.pid, controlPort: port });
  let ready = false; const server = createServer((request, response) => { response.setHeader('content-type', 'application/json'); if (request.url === '/runtime/identity') response.end(JSON.stringify({ protocol: 'contentos-runtime', protocolVersion: 1, instanceId, hostPid: process.pid })); else if (request.url === '/runtime/status') response.end(JSON.stringify({ ...state, state: ready ? 'READY' : 'STARTING', uptimeMs: 1 })); else response.statusCode = 404, response.end('{}'); });
  await new Promise<void>((resolveListen) => server.listen(port, '127.0.0.1', resolveListen)); const client = new RuntimeClient({ env }); const started = Date.now(); setTimeout(() => { ready = true; }, 350); const result = await client.waitForReady({ timeoutMs: 2_000, expectedInstanceId: instanceId }); assert.equal(result.state, 'READY'); assert.ok(Date.now() - started >= 250); server.closeAllConnections?.(); server.closeIdleConnections?.(); await new Promise<void>((resolveClose) => server.close(() => resolveClose())); await store.remove(); await rm(root, { recursive: true, force: true });
});

test('RuntimeClient rejects a non-ContentOS process on the control port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-client-conflict-')); const port = 3398;
  const server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ hello: 'world' })); });
  await new Promise<void>((resolveListen) => server.listen(port, '127.0.0.1', resolveListen));
  const client = new RuntimeClient({ env: { CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime'), STORAGE_ROOT: join(root, 'storage'), DATABASE_URL: 'postgresql://unused', CONTENTOS_RUNTIME_CONTROL_PORT: String(port) } });
  await assert.rejects(() => client.start({ timeoutMs: 500 }), (error: unknown) => (error as { code?: string }).code === 'RUNTIME_CONTROL_PORT_CONFLICT');
  server.closeAllConnections?.(); server.closeIdleConnections?.(); await new Promise<void>((resolveClose) => server.close(() => resolveClose())); await rm(root, { recursive: true, force: true });
});

test('RuntimeClient clears a dead FAILED state before starting a new instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-client-stale-failed-')); const port = 3396; const env = { CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime'), STORAGE_ROOT: join(root, 'storage'), DATABASE_URL: 'postgresql://unused', CONTENTOS_RUNTIME_CONTROL_PORT: String(port) };
  const store = new RuntimeStateStore(resolveRuntimePaths(env)); const stale = { instanceId: 'stale-failed', hostPid: 999999, startedAt: new Date().toISOString(), controlPort: port, controlToken: 'stale', state: 'FAILED' as const, services: [], warnings: ['old failure'] }; await store.write(stale); await store.acquire({ instanceId: stale.instanceId, hostPid: stale.hostPid, controlPort: port });
  const instanceId = 'fresh-instance'; const server = createServer((request, response) => { response.setHeader('content-type', 'application/json'); if (request.url === '/runtime/identity') return response.end(JSON.stringify({ protocol: 'contentos-runtime', protocolVersion: 1, instanceId, hostPid: process.pid })); if (request.url === '/runtime/status') return response.end(JSON.stringify({ ...stale, instanceId, hostPid: process.pid, state: 'READY', controlToken: 'fresh', uptimeMs: 1 })); response.end('{}'); });
  const runtimeClientClass = RuntimeClient as unknown as { spawnHost: (options?: unknown) => Promise<void> }; const originalSpawn = runtimeClientClass.spawnHost;
  runtimeClientClass.spawnHost = async () => { const fresh = { ...stale, instanceId, hostPid: process.pid, controlToken: 'fresh', state: 'STARTING' as const }; await store.write(fresh); await store.acquire({ instanceId, hostPid: process.pid, controlPort: port }); await new Promise<void>((resolveListen) => server.listen(port, '127.0.0.1', resolveListen)); await store.write({ ...fresh, state: 'READY' }); };
  try { const result = await new RuntimeClient({ env }).start({ timeoutMs: 2_000 }); assert.equal(result.state, 'READY'); } finally { runtimeClientClass.spawnHost = originalSpawn; server.closeAllConnections?.(); server.closeIdleConnections?.(); await new Promise<void>((resolveClose) => server.close(() => resolveClose())); await store.remove(); await rm(root, { recursive: true, force: true }); }
});
