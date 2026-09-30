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
const userDataRoot = await mkdtemp(join(tmpdir(), 'contentos-desktop-installer-user-data-'));

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

async function findFile(directory: string, fileName: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return candidate;
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, fileName);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function waitForUninstall(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const executable = await findExecutable(installRoot).catch(() => undefined);
    const uninstaller = await findFile(installRoot, 'Uninstall ContentOS.exe').catch(() => undefined);
    if (!executable && !uninstaller) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error('Installer uninstall did not remove the installed executable/uninstaller');
}

async function runSmoke(executable: string): Promise<void> {
  const tsx = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const smoke = resolve(root, 'scripts', 'test-desktop-package.ts');
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [tsx, smoke], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, CONTENTOS_SMOKE_EXECUTABLE: executable, CONTENTOS_SMOKE_USER_DATA_ROOT: userDataRoot } });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => { if (code === 0) resolveRun(); else rejectRun(new Error(`installed packaged smoke exited with ${code ?? 'null'}${signal ? ` (${signal})` : ''}`)); });
  });
}

try {
  await execFileAsync(installer, ['/S', `/D=${installRoot}`], { timeout: 300_000, windowsHide: true });
  const executable = await findExecutable(installRoot);
  if (!executable) throw new Error(`installed ContentOS.exe not found under ${installRoot}`);
  await runSmoke(executable);
  const uninstaller = await findFile(installRoot, 'Uninstall ContentOS.exe');
  if (!uninstaller) throw new Error(`Uninstaller was not found under ${installRoot}`);
  await execFileAsync(uninstaller, ['/S'], { timeout: 120_000, windowsHide: true });
  await waitForUninstall();
  await access(join(userDataRoot, 'data', 'postgres', 'PG_VERSION'));
  console.log(JSON.stringify({ ok: true, installer, installRoot, executable, uninstaller, userDataRoot, userDataRetained: true }));
} finally {
  await rm(installRoot, { recursive: true, force: true }).catch(() => undefined);
  await rm(userDataRoot, { recursive: true, force: true }).catch(() => undefined);
}
