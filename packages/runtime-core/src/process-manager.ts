import { appendFile, mkdir } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { RuntimePaths } from './paths.js';

export interface ManagedProcess { id: string; pid?: number; child: ChildProcess; startedAt: string; }
export interface ProcessExit { code: number | null; signal: NodeJS.Signals | null; }

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  constructor(private readonly paths: RuntimePaths) {}
  async start(id: string, command: string, args: string[], env: Record<string, string> = {}): Promise<ManagedProcess> {
    await mkdir(this.paths.logsRoot, { recursive: true }); const logPath = join(this.paths.logsRoot, `${id}.log`); const child = spawn(command, args, { cwd: this.paths.appRoot, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const managed: ManagedProcess = { id, ...(child.pid ? { pid: child.pid } : {}), child, startedAt: new Date().toISOString() }; this.processes.set(id, managed);
    const write = (chunk: Buffer, level: string) => { void appendFile(logPath, `${new Date().toISOString()} ${level} ${chunk.toString()}`, 'utf8'); };
    child.stdout?.on('data', (chunk: Buffer) => write(chunk, 'INFO')); child.stderr?.on('data', (chunk: Buffer) => write(chunk, 'ERROR'));
    child.once('exit', () => this.processes.delete(id));
    return managed;
  }
  get(id: string): ManagedProcess | undefined { return this.processes.get(id); }
  async stop(id: string, timeoutMs = 10_000): Promise<ProcessExit | undefined> {
    const managed = this.processes.get(id); if (!managed) return undefined; const child = managed.child;
    if (child.exitCode !== null || child.signalCode) { this.processes.delete(id); return { code: child.exitCode, signal: child.signalCode }; }
    await new Promise<void>((resolve) => { let done = false; const finish = () => { if (done) return; done = true; resolve(); }; child.once('exit', finish); try { child.kill('SIGINT'); } catch { finish(); } setTimeout(() => { if (!done) { try { child.kill(); } catch { /* already gone */ } finish(); } }, timeoutMs).unref(); });
    this.processes.delete(id); return { code: child.exitCode, signal: child.signalCode };
  }
  async stopAll(ids: string[], timeoutMs = 10_000): Promise<void> { for (const id of ids) await this.stop(id, timeoutMs); }
}
