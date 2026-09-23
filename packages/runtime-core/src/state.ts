import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RuntimeStateFile } from './types.js';
import type { RuntimePaths } from './paths.js';
import { isProcessAlive } from './port.js';

type RuntimeOwner = { instanceId: string; hostPid: number; controlPort: number };
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export class RuntimeStateStore {
  readonly path: string;
  readonly lockPath: string;
  private readonly cleanupPrefix: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly paths: RuntimePaths) {
    this.path = join(paths.stateRoot, 'runtime.json');
    this.lockPath = join(paths.stateRoot, 'runtime.lock');
    this.cleanupPrefix = join(paths.stateRoot, 'runtime.cleanup.');
  }

  async read(): Promise<RuntimeStateFile | null> {
    try { return JSON.parse(await readFile(this.path, 'utf8')) as RuntimeStateFile; } catch { return null; }
  }

  async readLock(): Promise<Record<string, unknown> | null> {
    try { return JSON.parse(await readFile(this.lockPath, 'utf8')) as Record<string, unknown>; } catch { return null; }
  }

  async write(state: RuntimeStateFile): Promise<void> {
    const content = JSON.stringify(state, null, 2);
    const write = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, 'utf8');
        await rename(temporary, this.path);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.writeQueue = write;
    await write;
  }

  async remove(): Promise<void> {
    await this.writeQueue.catch(() => undefined);
    await Promise.all([rm(this.path, { force: true }), rm(this.lockPath, { force: true })]);
  }

  /** Remove only files still owned by this Runtime. The cleanup marker prevents
   * a new owner from completing acquisition while the state/lock pair changes. */
  async removeOwned(owner: RuntimeOwner): Promise<boolean> {
    await this.writeQueue.catch(() => undefined);
    const token = await this.beginCleanup();
    if (!token) return false;
    const claimed: string[] = [];
    try {
      const lock = await this.readLock();
      if (!lock || !sameIdentity(lock, owner)) return false;
      const state = await this.read();
      if (state && !sameIdentity(state, owner)) return false;
      if (state) claimed.push(await this.claimPath(this.path, 'owned'));
      const replacementLock = await this.readLock();
      if (replacementLock && !sameIdentity(replacementLock, owner)) return false;
      claimed.push(await this.claimPath(this.lockPath, 'owned'));
      return true;
    } finally {
      await Promise.all(claimed.map((path) => rm(path, { force: true }).catch(() => undefined)));
      await this.endCleanup(token);
    }
  }

  /** Atomically claims the stale lock, then removes its state only while a
   * cleanup transaction blocks new owners from publishing state. */
  async claimStale(expectedLock: Record<string, unknown> | null, expectedState: RuntimeStateFile | null): Promise<boolean> {
    await this.writeQueue.catch(() => undefined);
    const token = await this.beginCleanup();
    if (!token) return false;
    const claimed: string[] = [];
    try {
      const currentLock = await this.readLock();
      if (expectedLock) {
        if (!currentLock || !sameIdentity(currentLock, expectedLock)) return false;
        try { claimed.push(await this.claimPath(this.lockPath, 'stale')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      } else if (currentLock) return false;

      // A process which passed the initial marker check may have written a
      // replacement lock. It cannot publish state until the marker is gone.
      if (await this.readLock()) return false;

      if (expectedState) {
        const state = await this.read();
        if (!state || !sameIdentity(state, expectedState)) return false;
        // Check ownership again immediately before claiming the old state.
        if (await this.readLock()) return false;
        try { claimed.push(await this.claimPath(this.path, 'stale')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      }
      return true;
    } finally {
      await Promise.all(claimed.map((path) => rm(path, { force: true }).catch(() => undefined)));
      await this.endCleanup(token);
    }
  }

  async acquire(lock: RuntimeOwner): Promise<void> {
    await mkdir(dirname(this.lockPath), { recursive: true });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await this.waitForCleanup();
      const temporary = `${this.lockPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(lock, null, 2), { encoding: 'utf8', flag: 'wx' });
        try { await link(temporary, this.lockPath); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Object.assign(new Error('RUNTIME_LOCK_EXISTS'), { code: 'RUNTIME_LOCK_EXISTS' });
          throw error;
        }
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }

      // Close the race with a cleanup marker created just after our first
      // check. A lock written during cleanup is removed before acquisition can
      // return, so its owner cannot publish runtime.json yet.
      if (!(await this.cleanupInProgress())) return;
      await this.removeLockIfOwned(lock);
      await sleep(10);
    }
    throw Object.assign(new Error('Runtime cleanup transaction did not finish'), { code: 'RUNTIME_CLEANUP_IN_PROGRESS' });
  }

  private async removeLockIfOwned(owner: RuntimeOwner): Promise<void> {
    const lock = await this.readLock();
    if (!lock || !sameIdentity(lock, owner)) return;
    const claimed = await this.claimPath(this.lockPath, 'cancelled').catch(() => undefined);
    if (claimed) await rm(claimed, { force: true }).catch(() => undefined);
  }

  private async beginCleanup(): Promise<string | null> {
    await mkdir(dirname(this.cleanupPrefix), { recursive: true });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const token = randomUUID();
      const markerPath = `${this.cleanupPrefix}${token}`;
      let handle;
      try {
        handle = await open(markerPath, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') { await sleep(10); continue; }
        throw error;
      }
      try { await handle.writeFile(JSON.stringify({ token, hostPid: process.pid, createdAt: new Date().toISOString() })); }
      catch (error) { await handle.close().catch(() => undefined); await rm(markerPath, { force: true }).catch(() => undefined); throw error; }
      await handle.close();
      return token;
    }
    return null;
  }

  private async endCleanup(token: string): Promise<void> {
    try {
      const markerPath = `${this.cleanupPrefix}${token}`;
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { token?: unknown };
      if (marker.token === token) await rm(markerPath, { force: true });
    } catch { /* preserve the original cleanup result */ }
  }

  private async cleanupInProgress(): Promise<boolean> {
    let names: string[];
    try { names = await readdir(dirname(this.cleanupPrefix)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    let active = false;
    for (const name of names.filter((item) => item.startsWith('runtime.cleanup.'))) {
      const markerPath = join(dirname(this.cleanupPrefix), name);
      try {
        const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { hostPid?: unknown };
        if (typeof marker.hostPid === 'number' && isProcessAlive(marker.hostPid)) active = true;
        else await rm(markerPath, { force: true });
      } catch {
        try {
          const details = await stat(markerPath);
          if (Date.now() - details.mtimeMs > 30_000) await rm(markerPath, { force: true });
          else active = true;
        } catch { /* marker disappeared while another waiter reclaimed it */ }
      }
    }
    return active;
  }

  private async waitForCleanup(): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (!(await this.cleanupInProgress())) return;
      await sleep(10);
    }
    throw Object.assign(new Error('Runtime cleanup transaction is still in progress'), { code: 'RUNTIME_CLEANUP_IN_PROGRESS' });
  }

  private async claimPath(path: string, kind: string): Promise<string> {
    const claimed = `${path}.${kind}.${randomUUID()}`;
    await rename(path, claimed);
    return claimed;
  }
}

function sameIdentity(left: { instanceId?: unknown; hostPid?: unknown; controlPort?: unknown }, right: { instanceId?: unknown; hostPid?: unknown; controlPort?: unknown }): boolean {
  return left.instanceId === right.instanceId && left.hostPid === right.hostPid && left.controlPort === right.controlPort;
}
