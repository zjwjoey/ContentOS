import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface StagedBlob { tempPath: string; checksum: string; byteSize: number; originalName: string; }

async function walk(directory: string): Promise<string[]> {
  try { await stat(directory); } catch { return []; }
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
}

export class LocalStorageProvider {
  constructor(readonly root: string) {}
  private stagingRoot(): string { return join(this.root, 'staging'); }
  private objectsRoot(): string { return join(this.root, 'objects'); }
  objectPath(storageKey: string): string { return join(this.root, storageKey); }
  async stage(sourcePath: string): Promise<StagedBlob> {
    const data = await readFile(sourcePath);
    const checksum = createHash('sha256').update(data).digest('hex');
    await mkdir(this.stagingRoot(), { recursive: true });
    const tempPath = join(this.stagingRoot(), `${randomUUID()}.part`);
    await copyFile(sourcePath, tempPath);
    return { tempPath, checksum, byteSize: data.byteLength, originalName: sourcePath.split(/[\\/]/).pop() || 'asset' };
  }
  async promote(staged: StagedBlob): Promise<{ storageKey: string; deduped: boolean }> {
    const storageKey = join('objects', staged.checksum.slice(0, 2), staged.checksum);
    const destination = this.objectPath(storageKey);
    await mkdir(join(this.objectsRoot(), staged.checksum.slice(0, 2)), { recursive: true });
    try { await stat(destination); await rm(staged.tempPath, { force: true }); return { storageKey, deduped: true }; }
    catch { /* destination does not exist */ }
    await rename(staged.tempPath, destination);
    return { storageKey, deduped: false };
  }
  async exists(storageKey: string): Promise<boolean> { try { await stat(this.objectPath(storageKey)); return true; } catch { return false; } }
  async listObjectKeys(): Promise<string[]> { return (await walk(this.objectsRoot())).map((file) => relative(this.root, file).replaceAll('\\', '/')); }
  async cleanupStaging(): Promise<number> {
    const files = await walk(this.stagingRoot());
    await Promise.all(files.map((file) => rm(file, { force: true })));
    return files.length;
  }
}
