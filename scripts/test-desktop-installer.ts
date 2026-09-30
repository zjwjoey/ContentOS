import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const installer = resolve(process.env.CONTENTOS_INSTALLER_PATH || 'artifacts/desktop/ContentOS Setup.exe');
if (process.platform !== 'win32') throw new Error('desktop installer smoke currently requires win32-x64');
await access(installer);

const installRoot = await mkdtemp(join(tmpdir(), 'contentos-desktop-installer-smoke-'));

async function findExecutable(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === 'contentos.exe') return candidate;
    if (entry.isDirectory()) {
      const nested = await findExecutable(candidate);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function runSmoke(executable: string): Promise<void> {
  const tsx = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const smoke = resolve(root, 'scripts', 'test-desktop-package.ts');
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [tsx, smoke], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, CONTENTOS_SMOKE_EXECUTABLE: executable } });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => { if (code === 0) resolveRun(); else rejectRun(new Error(`installed packaged smoke exited with ${code ?? 'null'}${signal ? ` (${signal})` : ''}`)); });
  });
}

try {
  await execFileAsync(installer, ['/S', `/D=${installRoot}`], { timeout: 300_000, windowsHide: true });
  const executable = await findExecutable(installRoot);
  if (!executable) throw new Error(`installed ContentOS.exe not found under ${installRoot}`);
  await runSmoke(executable);
  console.log(JSON.stringify({ ok: true, installer, installRoot, executable }));
} finally {
  await rm(installRoot, { recursive: true, force: true }).catch(() => undefined);
}
