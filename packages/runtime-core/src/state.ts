import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { RuntimeStateFile } from './types.js';
import type { RuntimePaths } from './paths.js';

export class RuntimeStateStore {
  readonly path: string;
  readonly lockPath: string;
  constructor(private readonly paths: RuntimePaths) { this.path = join(paths.stateRoot, 'runtime.json'); this.lockPath = join(paths.stateRoot, 'runtime.lock'); }
  async read(): Promise<RuntimeStateFile | null> { try { return JSON.parse(await readFile(this.path, 'utf8')) as RuntimeStateFile; } catch { return null; } }
  async readLock(): Promise<Record<string, unknown> | null> { try { return JSON.parse(await readFile(this.lockPath, 'utf8')) as Record<string, unknown>; } catch { return null; } }
  async write(state: RuntimeStateFile): Promise<void> { await mkdir(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8'); await rename(temporary, this.path); }
  async remove(): Promise<void> { await Promise.all([rm(this.path, { force: true }), rm(this.lockPath, { force: true })]); }
  async claimStale(expectedLock: Record<string, unknown> | null, expectedState: RuntimeStateFile | null): Promise<boolean> {
    const currentLock = await this.readLock();
    if (expectedLock) {
      if (!currentLock || !sameIdentity(currentLock, expectedLock)) return false;
      const claimedLock = `${this.lockPath}.stale.${randomUUID()}`;
      try { await rename(this.lockPath, claimedLock); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      await rm(claimedLock, { force: true });
    } else if (currentLock) return false;
    if (expectedState) {
      const currentState = await this.read();
      if (!currentState || !sameIdentity(currentState, expectedState)) return false;
      const claimedState = `${this.path}.stale.${randomUUID()}`;
      try { await rename(this.path, claimedState); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      await rm(claimedState, { force: true });
    }
    return true;
  }
  async acquire(lock: Record<string, unknown>): Promise<void> { await mkdir(dirname(this.lockPath), { recursive: true }); try { const handle = await import('node:fs/promises').then((fs) => fs.open(this.lockPath, 'wx')); await handle.writeFile(JSON.stringify(lock, null, 2)); await handle.close(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; throw Object.assign(new Error('RUNTIME_LOCK_EXISTS'), { code: 'RUNTIME_LOCK_EXISTS' }); } }
}

function sameIdentity(left: { instanceId?: unknown; hostPid?: unknown; controlPort?: unknown }, right: { instanceId?: unknown; hostPid?: unknown; controlPort?: unknown }): boolean { return left.instanceId === right.instanceId && left.hostPid === right.hostPid && left.controlPort === right.controlPort; }
