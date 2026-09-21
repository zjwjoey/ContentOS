import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import type { LocalStorageProvider } from '../../../infrastructure/storage/src/index.js';

export interface ImportAssetInput { projectId?: string; workspaceId?: string; global?: boolean; sourcePath: string; kind: string; role?: 'SOURCE' | 'VOICE' | 'OUTPUT'; metadata?: Record<string, unknown>; skipProbe?: boolean; }
export interface AssetResult { id: string; projectId: string; workspaceId?: string; checksum: string; storageKey: string; byteSize: number; status: 'READY' | 'DEDUPED'; associationCreated?: boolean; }
export interface AssetProbe { durationMs?: number; width?: number; height?: number; format?: string; }
export interface AssetTransaction { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }
const preparedAssetImportBrand: unique symbol = Symbol('PreparedAssetImport');
export interface PreparedAssetImport { readonly [preparedAssetImportBrand]: true; readonly checksum: string; readonly byteSize: number; readonly storageKey: string; readonly originalName: string; readonly probe: AssetProbe | undefined; readonly deduped: boolean; }

class ActivePreparedAssetImport implements PreparedAssetImport {
  readonly [preparedAssetImportBrand] = true;
  constructor(readonly checksum: string, readonly byteSize: number, readonly storageKey: string, readonly originalName: string, readonly storageOwner: LocalStorageProvider, readonly probe: AssetProbe | undefined, readonly deduped: boolean) { Object.freeze(this); }
}

export class AssetService {
  constructor(private readonly db: Pool, private readonly storage: LocalStorageProvider, private readonly probe?: (path: string) => Promise<AssetProbe>) {}
  async prepareFile(input: ImportAssetInput): Promise<PreparedAssetImport> {
    const staged = await this.storage.stage(input.sourcePath);
    const probe = this.probe && !input.skipProbe ? await this.probe(input.sourcePath) : undefined;
    const promoted = await this.storage.promote(staged);
    return new ActivePreparedAssetImport(staged.checksum, staged.byteSize, promoted.storageKey, staged.originalName, this.storage, probe, promoted.deduped);
  }
  async commitPrepared(input: ImportAssetInput, prepared: PreparedAssetImport, transaction?: AssetTransaction): Promise<AssetResult> {
    if (!(prepared instanceof ActivePreparedAssetImport) || prepared.storageOwner !== this.storage) throw new Error('Prepared Asset handle is not owned by this Asset service');
    if (!(await this.storage.exists(prepared.storageKey))) throw new Error('Prepared Asset blob is unavailable');
    const ownerCount = Number(input.projectId !== undefined) + Number(input.workspaceId !== undefined) + Number(input.global === true);
    if (ownerCount !== 1) throw new Error('Asset import requires exactly one projectId, workspaceId or global scope');
    const db = transaction || this.db;
    // Render outputs are project-scoped even when two projects happen to produce
    // byte-identical files; deduplication is reserved for source/import assets.
    const existing = input.global
      ? await db.query('select * from assets where checksum = $1 and kind <> $2 and project_id is null limit 1', [prepared.checksum, 'VIDEO_RENDER'])
      : await db.query('select * from assets where checksum = $1 and kind <> $2 limit 1', [prepared.checksum, 'VIDEO_RENDER']);
    if (existing.rows[0]) {
      const row = existing.rows[0] as Record<string, unknown>;
      let associationCreated = false;
      if (input.projectId) associationCreated = (await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3) on conflict do nothing returning asset_id', [input.projectId, String(row.id), input.role || 'SOURCE'])).rows.length > 0;
      else if (input.workspaceId) associationCreated = (await db.query('insert into video_workspace_assets (workspace_id, asset_id, role) values ($1, $2, $3) on conflict do nothing returning asset_id', [input.workspaceId, String(row.id), input.role || 'SOURCE'])).rows.length > 0;
      return { id: String(row.id), projectId: input.projectId || '', ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), checksum: prepared.checksum, storageKey: String(row.storage_key), byteSize: Number(row.byte_size), status: 'DEDUPED', associationCreated };
    }
    const id = `asset-${randomUUID()}`;
    const metadata = { originalName: prepared.originalName, ...(prepared.probe || {}), ...(input.metadata || {}) };
    const result = await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *', [id, input.projectId || null, input.kind, prepared.checksum, prepared.byteSize, prepared.storageKey, 'READY', metadata]);
    let associationCreated = false;
    if (input.projectId) associationCreated = (await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3) on conflict do nothing returning asset_id', [input.projectId, id, input.role || 'SOURCE'])).rows.length > 0;
    else if (input.workspaceId) associationCreated = (await db.query('insert into video_workspace_assets (workspace_id, asset_id, role) values ($1, $2, $3) on conflict do nothing returning asset_id', [input.workspaceId, id, input.role || 'SOURCE'])).rows.length > 0;
    const row = result.rows[0] as Record<string, unknown>;
    return { id, projectId: input.projectId || '', ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), checksum: prepared.checksum, storageKey: String(row.storage_key), byteSize: prepared.byteSize, status: 'READY', associationCreated };
  }
  async prepareStagedUpload(input: ImportAssetInput & { stagedPath: string; originalName: string; checksum: string; byteSize: number; probe?: AssetProbe }): Promise<PreparedAssetImport> {
    const promoted = await this.storage.promote({ tempPath: this.storage.stagedPath(input.stagedPath), checksum: input.checksum, byteSize: input.byteSize, originalName: input.originalName });
    return new ActivePreparedAssetImport(input.checksum, input.byteSize, promoted.storageKey, input.originalName, this.storage, input.probe, promoted.deduped);
  }
  async importFile(input: ImportAssetInput, transaction?: AssetTransaction): Promise<AssetResult> {
    return this.commitPrepared(input, await this.prepareFile(input), transaction);
  }
  async removeProjectAssetAssociation(projectId: string, assetId: string, role: 'SOURCE' | 'VOICE' | 'OUTPUT' = 'OUTPUT'): Promise<boolean> {
    const result = await this.db.query('delete from project_assets where project_id = $1 and asset_id = $2 and role = $3 returning asset_id', [projectId, assetId, role]);
    return result.rows.length > 0;
  }
  async importGlobalStaged(input: { stagedPath: string; originalName: string; byteSize: number }): Promise<AssetResult> {
    const stagedAbsolutePath = this.storage.stagedPath(input.stagedPath);
    const bytes = await readFile(stagedAbsolutePath);
    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const probe = this.probe ? await this.probe(stagedAbsolutePath) : undefined;
    const prepared = await this.prepareStagedUpload({ global: true, sourcePath: stagedAbsolutePath, kind: 'VIDEO', stagedPath: input.stagedPath, originalName: input.originalName, checksum, byteSize: bytes.byteLength, ...(probe ? { probe } : {}) });
    try {
      return await this.commitPrepared({ global: true, sourcePath: stagedAbsolutePath, kind: 'VIDEO' }, prepared);
    } catch (error) {
      if (!prepared.deduped) await this.storage.removeObject(prepared.storageKey);
      throw error;
    }
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
