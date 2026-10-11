import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '../../packages/logging/src/index.js';
import { serializeError } from '../../packages/shared/src/errors.js';
import { ProcessManager } from '../../packages/runtime-core/src/process-manager.js';
import { resolveRuntimePaths } from '../../packages/runtime-core/src/paths.js';

test('diagnostic messages redact embedded credentials while retaining useful context', () => {
  const lines: string[] = [];
  const message = 'provider timeout password=fixture-password api_key=fixture-key Bearer fixture-bearer https://user:fixture-url-password@host/path?token=fixture-query';
  createLogger((line) => lines.push(line)).error('provider.failed', { error: { message }, correlationId: 'corr-safe' });
  const serialized = serializeError(new Error(message), 'ExternalProcessError', 'corr-safe');
  const output = `${lines.join('\n')} ${JSON.stringify(serialized)}`;
  assert.doesNotMatch(output, /fixture-password|fixture-key|fixture-bearer|fixture-url-password|fixture-query/);
  assert.match(output, /provider timeout/); assert.match(output, /corr-safe/);
});

test('runtime logs redact credentials split across process output chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-safe-logs-'));
  const paths = resolveRuntimePaths({ CONTENTOS_APP_ROOT: process.cwd(), CONTENTOS_RUNTIME_ROOT: root });
  const manager = new ProcessManager(paths);
  try {
    const child = await manager.start('log-fixture', process.execPath, ['-e', "process.stdout.write('provider password=fixture-'); setTimeout(()=>{process.stdout.write('password retrying\\n'); process.stderr.write('Authorization: Bearer fixture-bearer\\n');},30); setTimeout(()=>process.exit(0),80)"]);
    await new Promise<void>((resolve) => child.child.once('close', () => resolve()));
    let output = '';
    const deadline = Date.now() + 2_000;
    while (!output.includes('retrying') && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 20)); output = await readFile(join(paths.logsRoot, 'log-fixture.log'), 'utf8').catch(() => ''); }
    assert.match(output, /retrying/);
    assert.doesNotMatch(output, /fixture-password|fixture-bearer/);
  } finally { await manager.stop('log-fixture'); await rm(root, { recursive: true, force: true }); }
});
