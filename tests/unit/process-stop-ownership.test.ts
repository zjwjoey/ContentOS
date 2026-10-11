import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProcessManager, resolveRuntimePaths } from '../../packages/runtime-core/src/index.js';

test('Windows process stop never kills a PID again after the owned child has exited', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-stop-ownership-'));
  const manager = new ProcessManager(resolveRuntimePaths({ CONTENTOS_APP_ROOT: root, CONTENTOS_RUNTIME_ROOT: join(root, 'runtime') }));
  const process = await manager.start('owned', globalThis.process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const internal = manager as unknown as { terminateTree: (pid: number | undefined) => Promise<void>; waitForPidExit: () => Promise<boolean> };
  const terminate = internal.terminateTree.bind(manager); let calls = 0;
  // A recycled numeric PID can look alive while the actual child handle is exited.
  internal.waitForPidExit = async () => false;
  internal.terminateTree = async (pid) => { calls += 1; if (calls === 1) await terminate(pid); };
  try {
    await manager.stop('owned', 1_000);
    assert.ok(process.child.exitCode !== null || process.child.signalCode !== null);
    assert.equal(calls, 1, 'do not use a stale PID to kill a different process');
  } finally { await manager.stop('owned', 1_000); await rm(root, { recursive: true, force: true }); }
});
