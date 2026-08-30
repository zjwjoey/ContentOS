import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

async function discover(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await discover(target)));
    else if (/\.test\.(?:js|ts)$/.test(entry.name)) files.push(target);
  }
  return files;
}

const files = (await discover(resolve(process.cwd(), 'tests'))).sort();
if (process.argv.includes('--list')) {
  console.log(files.join('\n'));
  console.log(`Discovered ${files.length} test files`);
  process.exit(0);
}
if (files.length === 0) throw new Error('No test files discovered under tests/');
const tsx = resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawn(process.execPath, [tsx, '--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env: process.env });
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
