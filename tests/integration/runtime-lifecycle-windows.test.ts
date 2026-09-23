import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessManager, RuntimeStateStore, InstanceGuard, isPortOpen, probeRuntimeIdentity, resolveRuntimePaths } from '../../packages/runtime-core/src/index.js';

test('Windows runtime lifecycle keeps control identity, restart and process-tree stop safe', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-windows-runtime-'));
  const port = 3487;
  const paths = resolveRuntimePaths({ CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime') });
  const manager = new ProcessManager(paths);
  const serverScript = "const http=require('http'); const id=process.env.CONTENTOS_TEST_INSTANCE; const port=Number(process.env.CONTENTOS_TEST_PORT); http.createServer((req,res)=>{res.setHeader('content-type','application/json'); if(req.url==='/runtime/identity') return res.end(JSON.stringify({protocol:'contentos-runtime',protocolVersion:1,instanceId:id,hostPid:process.pid})); if(req.url==='/runtime/status') return res.end(JSON.stringify({state:'READY'})); res.end('{}');}).listen(port,'127.0.0.1'); setInterval(()=>{},1000);";
  try {
    const first = await manager.start('runtime-host', process.execPath, ['-e', serverScript], { CONTENTOS_TEST_PORT: String(port), CONTENTOS_TEST_INSTANCE: 'windows-one' });
    for (let attempt = 0; attempt < 30 && !(await isPortOpen(port)); attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    const identity = await probeRuntimeIdentity(port);
    assert.equal(identity?.instanceId, 'windows-one');
    await manager.stop('runtime-host', 2_000);
    const second = await manager.start('runtime-host', process.execPath, ['-e', serverScript], { CONTENTOS_TEST_PORT: String(port), CONTENTOS_TEST_INSTANCE: 'windows-two' });
    assert.notEqual(first.pid, second.pid);
    for (let attempt = 0; attempt < 30 && !(await isPortOpen(port)); attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.equal((await probeRuntimeIdentity(port))?.instanceId, 'windows-two');
    await manager.stop('runtime-host', 2_000);
    assert.equal(await isPortOpen(port), false);

    const store = new RuntimeStateStore(paths);
    const stale = { instanceId: 'stale', hostPid: 999999, controlPort: port, controlToken: 'stale-token', startedAt: new Date().toISOString(), state: 'FAILED' as const, services: [], warnings: [] };
    await store.write(stale); await store.acquire({ instanceId: 'stale', hostPid: 999999, controlPort: port });
    const guard = new InstanceGuard(store, port); const inspection = await guard.inspect(); assert.equal(inspection.disposition, 'STALE'); assert.equal(await guard.cleanupStale(inspection), true);
    const results = await Promise.allSettled([1, 2, 3].map((index) => store.acquire({ instanceId: `parallel-${index}`, hostPid: process.pid, controlPort: port })));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    await store.remove();
  } finally { await manager.stop('runtime-host', 2_000).catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
