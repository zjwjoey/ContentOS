import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { LocalStorageProvider } from '../../../infrastructure/storage/src/index.js';

export interface ImportAssetInput { projectId: string; sourcePath: string; kind: string; }
export interface AssetResult { id: string; projectId: string; checksum: string; storageKey: string; byteSize: number; status: 'READY' | 'DEDUPED'; }
export interface AssetProbe { durationMs?: number; width?: number; height?: number; format?: string; }
export interface AssetTransaction { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }
const preparedAssetImportBrand: unique symbol = Symbol('PreparedAssetImport');
export interface PreparedAssetImport { readonly [preparedAssetImportBrand]: true; readonly checksum: string; readonly byteSize: number; readonly storageKey: string; readonly originalName: string; readonly probe: AssetProbe | undefined; }

class ActivePreparedAssetImport implements PreparedAssetImport {
  readonly [preparedAssetImportBrand] = true;
  constructor(readonly checksum: string, readonly byteSize: number, readonly storageKey: string, readonly originalName: string, readonly storageOwner: LocalStorageProvider, readonly probe: AssetProbe | undefined) { Object.freeze(this); }
}

export class AssetService {
  constructor(private readonly db: Pool, private readonly storage: LocalStorageProvider, private readonly probe?: (path: string) => Promise<AssetProbe>) {}
  async prepareFile(input: ImportAssetInput): Promise<PreparedAssetImport> {
    const staged = await this.storage.stage(input.sourcePath);
    const probe = this.probe ? await this.probe(input.sourcePath) : undefined;
    const promoted = await this.storage.promote(staged);
    return new ActivePreparedAssetImport(staged.checksum, staged.byteSize, promoted.storageKey, staged.originalName, this.storage, probe);
  }
  async commitPrepared(input: ImportAssetInput, prepared: PreparedAssetImport, transaction?: AssetTransaction): Promise<AssetResult> {
    if (!(prepared instanceof ActivePreparedAssetImport) || prepared.storageOwner !== this.storage) throw new Error('Prepared Asset handle is not owned by this Asset service');
    if (!(await this.storage.exists(prepared.storageKey))) throw new Error('Prepared Asset blob is unavailable');
    const db = transaction || this.db;
    const existing = await db.query('select * from assets where checksum = $1 limit 1', [prepared.checksum]);
    if (existing.rows[0]) {
      const row = existing.rows[0] as Record<string, unknown>;
      await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3) on conflict do nothing', [input.projectId, String(row.id), 'SOURCE']);
      return { id: String(row.id), projectId: input.projectId, checksum: prepared.checksum, storageKey: String(row.storage_key), byteSize: Number(row.byte_size), status: 'DEDUPED' };
    }
    const id = `asset-${randomUUID()}`;
    const result = await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *', [id, input.projectId, input.kind, prepared.checksum, prepared.byteSize, prepared.storageKey, 'READY', { originalName: prepared.originalName, ...(prepared.probe || {}) }]);
    await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3) on conflict do nothing', [input.projectId, id, 'SOURCE']);
    const row = result.rows[0] as Record<string, unknown>;
    return { id, projectId: input.projectId, checksum: prepared.checksum, storageKey: String(row.storage_key), byteSize: prepared.byteSize, status: 'READY' };
  }
  async importFile(input: ImportAssetInput, transaction?: AssetTransaction): Promise<AssetResult> {
    return this.commitPrepared(input, await this.prepareFile(input), transaction);
  }
  async reconcile(projectId?: string): Promise<{ missingAssets: string[]; orphanBlobs: string[] }> {
    const rows = projectId
      ? await this.db.query<{ id: string; storage_key: string }>('select id, storage_key from assets where lifecycle = $1 and project_id = $2', ['READY', projectId])
      : await this.db.query<{ id: string; storage_key: string }>('select id, storage_key from assets where lifecycle = $1', ['READY']);
    const missingAssets: string[] = [];
    const known = new Set<string>();
    for (const row of rows.rows) { known.add(row.storage_key); if (!(await this.storage.exists(row.storage_key))) missingAssets.push(row.id); }
    const blobs = await this.storage.listObjectKeys();
    return { missingAssets, orphanBlobs: blobs.filter((blob) => !known.has(blob)) };
  }
}
