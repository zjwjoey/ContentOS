import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessManager, resolveRuntimePaths, isProcessAlive } from '../../packages/runtime-core/src/index.js';

test('ProcessManager rejects duplicate ids and gracefully stops a real child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-process-'));
  try {
    const manager = new ProcessManager(resolveRuntimePaths({ CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime') }));
    const child = await manager.start('child', process.execPath, ['-e', "process.on('SIGINT',()=>process.exit(0)); setInterval(()=>{},1000)"]);
    await assert.rejects(() => manager.start('child', process.execPath, ['-e', 'setInterval(()=>{},1000)']), /PROCESS_ALREADY_RUNNING/);
    const exit = await manager.stop('child', 1_000);
    assert.ok(exit);
    assert.equal(child.pid ? isProcessAlive(child.pid) : false, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ProcessManager force termination handles a child process tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-process-tree-')); const pidFile = join(root, 'grandchild.pid');
  try {
    const manager = new ProcessManager(resolveRuntimePaths({ CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime') }));
    const script = "const fs=require('fs'); const {spawn}=require('child_process'); process.on('SIGINT',()=>{}); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(process.argv[1],String(c.pid)); setInterval(()=>{},1000);";
    const child = await manager.start('tree', process.execPath, ['-e', script, pidFile]);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await access(pidFile); break; } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 25)); }
    }
    const grandchildPid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(grandchildPid > 0);
    const exit = await manager.stop('tree', 100);
    assert.equal(exit?.forced, true);
    assert.equal(child.pid ? isProcessAlive(child.pid) : false, false);
    for (let attempt = 0; attempt < 20 && isProcessAlive(grandchildPid); attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    assert.equal(isProcessAlive(grandchildPid), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ProcessManager parses READY markers across stdout chunks and lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-process-ready-'));
  try {
    const manager = new ProcessManager(resolveRuntimePaths({ CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime') }));
    const script = "process.stdout.write('normal log\\n{\\\"sta'); setTimeout(()=>{process.stdout.write('tus\\\":\\\"READY\\\",\\\"workerId\\\":\\\"test\\\"}\\n{\\\"status\\\":\\\"READY\\\"}\\n');},25); setInterval(()=>{},1000);";
    await manager.start('ready', process.execPath, ['-e', script]);
    for (let attempt = 0; attempt < 30 && !manager.isReady('ready'); attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    assert.equal(manager.isReady('ready'), true);
    await manager.stop('ready', 1_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
