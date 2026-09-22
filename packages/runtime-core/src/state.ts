import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RuntimeStateFile } from './types.js';
import type { RuntimePaths } from './paths.js';

export class RuntimeStateStore {
  readonly path: string;
  readonly lockPath: string;
  constructor(private readonly paths: RuntimePaths) { this.path = join(paths.stateRoot, 'runtime.json'); this.lockPath = join(paths.stateRoot, 'runtime.lock'); }
  async read(): Promise<RuntimeStateFile | null> { try { return JSON.parse(await readFile(this.path, 'utf8')) as RuntimeStateFile; } catch { return null; } }
  async write(state: RuntimeStateFile): Promise<void> { await mkdir(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8'); await rename(temporary, this.path); }
  async remove(): Promise<void> { await Promise.all([rm(this.path, { force: true }), rm(this.lockPath, { force: true })]); }
  async acquire(lock: Record<string, unknown>): Promise<void> { await mkdir(dirname(this.lockPath), { recursive: true }); try { const handle = await import('node:fs/promises').then((fs) => fs.open(this.lockPath, 'wx')); await handle.writeFile(JSON.stringify(lock, null, 2)); await handle.close(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; throw new Error('RUNTIME_LOCK_EXISTS'); } }
}
