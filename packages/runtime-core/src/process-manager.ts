import { appendFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { RuntimePaths } from './paths.js';
import { isProcessAlive } from './port.js';

const exec = promisify(execFile);

export interface ManagedProcess { id: string; pid?: number; child: ChildProcess; startedAt: string; }
export interface ProcessExit { code: number | null; signal: NodeJS.Signals | null; forced?: boolean; }

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly ready = new Set<string>();
  constructor(private readonly paths: RuntimePaths) {}
  async start(id: string, command: string, args: string[], env: Record<string, string> = {}): Promise<ManagedProcess> {
    const existing = this.processes.get(id);
    if (existing && existing.child.exitCode === null && existing.child.signalCode === null) throw Object.assign(new Error(`PROCESS_ALREADY_RUNNING:${id}`), { code: 'PROCESS_ALREADY_RUNNING', serviceId: id });
    if (existing) this.processes.delete(id);
    await mkdir(this.paths.logsRoot, { recursive: true }); const logPath = join(this.paths.logsRoot, `${id}.log`); const child = spawn(command, args, { cwd: this.paths.appRoot, env: { ...process.env, ...env }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const managed: ManagedProcess = { id, ...(child.pid ? { pid: child.pid } : {}), child, startedAt: new Date().toISOString() }; this.processes.set(id, managed);
    const write = (chunk: Buffer, level: string) => { void appendFile(logPath, `${new Date().toISOString()} ${level} ${chunk.toString()}`, 'utf8').catch((error) => { try { process.stderr.write(`[runtime-log:${id}] ${error instanceof Error ? error.message : String(error)}\n`); } catch { /* stderr is best effort */ } }); };
    child.stdout?.on('data', (chunk: Buffer) => { if (chunk.toString().includes('"status":"READY"')) this.ready.add(id); write(chunk, 'INFO'); }); child.stderr?.on('data', (chunk: Buffer) => write(chunk, 'ERROR'));
    child.once('exit', () => { this.ready.delete(id); if (this.processes.get(id)?.child === child) this.processes.delete(id); });
    return managed;
  }
  get(id: string): ManagedProcess | undefined { return this.processes.get(id); }
  isReady(id: string): boolean { return this.ready.has(id); }
  private async waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> { if (child.exitCode !== null || child.signalCode) return true; return new Promise<boolean>((resolveWait) => { let done = false; const finish = (value: boolean) => { if (done) return; done = true; resolveWait(value); }; child.once('exit', () => finish(true)); setTimeout(() => finish(false), timeoutMs).unref(); }); }
  private async waitForPidExit(pid: number | undefined, timeoutMs: number): Promise<boolean> { if (!pid || !isProcessAlive(pid)) return true; const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); if (!isProcessAlive(pid)) return true; } return !isProcessAlive(pid); }
  private async terminateTree(pid: number | undefined): Promise<void> {
    if (!pid) return;
    if (process.platform === 'win32') { await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined); return; }
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* process already exited */ } }
  }
  async stop(id: string, timeoutMs = 10_000): Promise<ProcessExit | undefined> {
    const managed = this.processes.get(id); if (!managed) return undefined; const child = managed.child; const pid = managed.pid;
    if (child.exitCode !== null || child.signalCode) { this.ready.delete(id); this.processes.delete(id); return { code: child.exitCode, signal: child.signalCode }; }
    let exited = false; let forced = false;
    if (process.platform === 'win32') {
      // Windows has no reliable signal-based process-group semantics. Kill the
      // root with its full process tree while the PID is still available.
      forced = true;
      await this.terminateTree(pid);
      exited = await this.waitForExit(child, Math.min(timeoutMs, 5_000));
    } else {
      try { child.kill('SIGINT'); } catch { /* fallback below */ }
      exited = await this.waitForExit(child, timeoutMs);
    }
    if (!exited) { forced = true; await this.terminateTree(pid); exited = await this.waitForExit(child, Math.min(timeoutMs, 5_000)); }
    if (!exited && pid && process.platform === 'win32') { await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined); await this.waitForExit(child, 2_000); }
    if (pid && !(await this.waitForPidExit(pid, 2_000))) { await this.terminateTree(pid); await this.waitForPidExit(pid, 2_000); }
    this.ready.delete(id); this.processes.delete(id); return { code: child.exitCode, signal: child.signalCode, ...(forced ? { forced: true } : {}) };
  }
  async stopAll(ids: string[], timeoutMs = 10_000): Promise<void> { for (const id of ids) await this.stop(id, timeoutMs); }
}
