import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { LocalStorageProvider } from '../../../infrastructure/storage/src/index.js';

export interface ImportAssetInput { projectId: string; sourcePath: string; kind: string; }
export interface AssetResult { id: string; projectId: string; checksum: string; storageKey: string; byteSize: number; status: 'READY' | 'DEDUPED'; }
export interface AssetProbe { durationMs?: number; width?: number; height?: number; format?: string; }

export class AssetService {
  constructor(private readonly db: Pool, private readonly storage: LocalStorageProvider, private readonly probe?: (path: string) => Promise<AssetProbe>) {}
  async importFile(input: ImportAssetInput): Promise<AssetResult> {
    const staged = await this.storage.stage(input.sourcePath);
    const probe = this.probe ? await this.probe(input.sourcePath) : undefined;
    const existing = await this.db.query('select * from assets where checksum = $1 limit 1', [staged.checksum]);
    if (existing.rows[0]) {
      await this.storage.promote(staged);
      const row = existing.rows[0] as Record<string, unknown>;
      await this.db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3) on conflict do nothing', [input.projectId, String(row.id), 'SOURCE']);
      return { id: String(row.id), projectId: input.projectId, checksum: staged.checksum, storageKey: String(row.storage_key), byteSize: Number(row.byte_size), status: 'DEDUPED' };
    }
    const promoted = await this.storage.promote(staged);
    const id = `asset-${randomUUID()}`;
    const result = await this.db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *', [id, input.projectId, input.kind, staged.checksum, staged.byteSize, promoted.storageKey, 'READY', { originalName: staged.originalName, ...(probe || {}) }]);
    await this.db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3) on conflict do nothing', [input.projectId, id, 'SOURCE']);
    const row = result.rows[0] as Record<string, unknown>;
    return { id, projectId: input.projectId, checksum: staged.checksum, storageKey: String(row.storage_key), byteSize: staged.byteSize, status: 'READY' };
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
