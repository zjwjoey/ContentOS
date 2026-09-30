import { access, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
type SmokeState = { state: string; controlPort: number; controlToken: string; hostPid: number; services: Array<{ id: string; state: string; port?: number }> };
type SmokeStatus = SmokeState & { launchMode?: string; databaseMode?: string; runtimeVersion?: string; ffmpegVersion?: string; postgresVersion?: string; buildTimestamp?: string };

if (process.platform !== 'win32') throw new Error('desktop packaged smoke currently requires win32-x64');
const executable = resolve(process.env.CONTENTOS_SMOKE_EXECUTABLE || 'artifacts/desktop/win-unpacked/ContentOS.exe');
await access(executable);
const root = await mkdtemp(join(tmpdir(), 'contentos-desktop-package-smoke-'));
const userData = join(root, 'user-data');
await mkdir(userData, { recursive: true });
const statePath = join(userData, 'runtime', 'state', 'runtime.json');
const resourceRoot = process.env.CONTENTOS_SMOKE_RESOURCES_ROOT;
const smokeTimeoutMs = Number(process.env.CONTENTOS_SMOKE_TIMEOUT_MS || 120_000);
let child: ChildProcess | undefined;
let childStdout = '';
let childStderr = '';
let forcedKill = false;
let smokeSucceeded = false;

async function readState(): Promise<SmokeState | undefined> {
  try { return JSON.parse(await readFile(statePath, 'utf8')) as SmokeState; } catch { return undefined; }
}
async function waitFor<T>(read: () => Promise<T | undefined>, predicate: (value: T) => boolean, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value && predicate(value)) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`packaged smoke timed out waiting for ${statePath}`);
}
async function waitForStateRemoval(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await readState())) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`packaged smoke state was not removed: ${statePath}`);
}
async function killTree(processToKill: ChildProcess | undefined): Promise<void> {
  if (!processToKill?.pid) return;
  for (let attempt = 0; attempt < 40 && processToKill.exitCode === null; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  if (processToKill.exitCode !== null) return;
  forcedKill = true;
  await execFileAsync('taskkill', ['/PID', String(processToKill.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }).catch(() => undefined);
  for (let attempt = 0; attempt < 40 && processToKill.exitCode === null; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 250));
}
async function removeSmokeRoot(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await rm(root, { recursive: true, force: true }); return; }
    catch (error) { if ((error as { code?: string }).code !== 'EBUSY' && (error as { code?: string }).code !== 'EPERM') throw error; await new Promise((resolveWait) => setTimeout(resolveWait, 500)); }
  }
}
async function readSmokeDiagnostics(): Promise<Record<string, string>> {
  const diagnostics: Record<string, string> = {};
  for (const directory of [join(userData, 'logs'), join(userData, 'runtime', 'startup-reports')]) {
    try {
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.log') && !name.endsWith('.json')) continue;
        const file = join(directory, name);
        diagnostics[file] = (await readFile(file, 'utf8')).slice(-8000);
      }
    } catch { /* diagnostics are best effort */ }
  }
  return diagnostics;
}

try {
  child = spawn(executable, [`--user-data-dir=${userData}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, CONTENTOS_USER_DATA_ROOT: userData, ...(resourceRoot ? { CONTENTOS_RESOURCES_ROOT: resolve(resourceRoot) } : {}) } });
  child.stdout?.on('data', (chunk: Buffer) => { childStdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { childStderr += chunk.toString(); });
  const readyState = await waitFor(readState, (value) => value.state === 'READY' || value.state === 'READY_WITH_WARNINGS', smokeTimeoutMs);
  const response = await fetch(`http://127.0.0.1:${readyState.controlPort}/runtime/status`);
  if (!response.ok) throw new Error(`runtime status returned HTTP ${response.status}`);
  const status = await response.json() as SmokeStatus;
  const serviceStates = Object.fromEntries(status.services.map((service) => [service.id, service.state]));
  if (serviceStates.database !== 'READY' || serviceStates.migration !== 'READY' || serviceStates.api !== 'READY' || serviceStates.web !== 'READY') throw new Error(`required service is not READY: ${JSON.stringify(serviceStates)}`);
  const stop = await fetch(`http://127.0.0.1:${readyState.controlPort}/runtime/stop`, { method: 'POST', headers: { authorization: `Bearer ${readyState.controlToken}` } });
  if (!stop.ok) throw new Error(`runtime stop returned HTTP ${stop.status}`);
  await waitForStateRemoval(smokeTimeoutMs);
  smokeSucceeded = true;
  console.log(JSON.stringify({ ok: true, executable, state: readyState.state, launchMode: status.launchMode, databaseMode: status.databaseMode, runtimeVersion: status.runtimeVersion, postgresVersion: status.postgresVersion, ffmpegVersion: status.ffmpegVersion, buildTimestamp: status.buildTimestamp, services: serviceStates, ports: status.services.filter((service) => service.port).map((service) => `${service.id}:${service.port}`) }));
} finally {
  const smokeChild = child;
  await killTree(smokeChild);
  if (!smokeSucceeded || (smokeChild && smokeChild.exitCode !== 0)) {
    if (smokeChild && (childStdout || childStderr)) console.error(JSON.stringify({ childExitCode: smokeChild.exitCode, forcedKill, childStdout, childStderr }));
    console.error(JSON.stringify({ runtimeDiagnostics: await readSmokeDiagnostics() }));
  }
  if (process.env.CONTENTOS_KEEP_SMOKE_ROOT !== '1') await removeSmokeRoot();
  else console.error(`packaged smoke root preserved at ${root}`);
}
