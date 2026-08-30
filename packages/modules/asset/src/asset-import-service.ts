import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AssetImportKind, AssetImportState } from '../../../contracts/src/index.js';

export interface AssetImportRecord {
  id: string; projectId: string; workspaceId: string; jobId: string | null; originalName: string; kind: AssetImportKind; byteSize: number; stagedPath: string; state: AssetImportState; outputAssetId: string | null; errorCode: string | null; errorMessage: string | null; correlationId: string; createdAt: string; updatedAt: string;
}
export interface CreateStagedAssetImportInput { projectId?: string; workspaceId?: string; originalName: string; kind: AssetImportKind; byteSize: number; stagedPath: string; correlationId: string; }
export interface AssetImportTransaction { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }

function map(row: Record<string, unknown>): AssetImportRecord {
  return { id: String(row.id), projectId: row.project_id ? String(row.project_id) : '', workspaceId: row.workspace_id ? String(row.workspace_id) : '', jobId: row.job_id ? String(row.job_id) : null, originalName: String(row.original_name), kind: String(row.kind) as AssetImportKind, byteSize: Number(row.byte_size), stagedPath: String(row.staged_path), state: String(row.state) as AssetImportState, outputAssetId: row.output_asset_id ? String(row.output_asset_id) : null, errorCode: row.error_code ? String(row.error_code) : null, errorMessage: row.error_message ? String(row.error_message) : null, correlationId: String(row.correlation_id), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() };
}

function safeName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 255 || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('..')) throw new Error('Asset import originalName is invalid');
  return name;
}
function safeStagePath(value: string): string { if (!value.trim() || value.includes('\\') || value.includes('..') || value.startsWith('/')) throw new Error('Asset import stagedPath is invalid'); return value; }

export class AssetImportService {
  constructor(private readonly db: Pool) {}

  async createStaged(input: CreateStagedAssetImportInput): Promise<AssetImportRecord> {
    if ((input.projectId ? 1 : 0) + (input.workspaceId ? 1 : 0) !== 1 || !['VIDEO', 'AUDIO'].includes(input.kind) || !Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) throw new Error('Asset import input is invalid');
    const result = await this.db.query('insert into asset_imports (id, project_id, workspace_id, original_name, kind, byte_size, staged_path, state, correlation_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *', [`asset-import-${randomUUID()}`, input.projectId || null, input.workspaceId || null, safeName(input.originalName), input.kind, input.byteSize, safeStagePath(input.stagedPath), 'STAGED', input.correlationId]);
    return map(result.rows[0] as Record<string, unknown>);
  }

  async get(projectId: string, id: string): Promise<AssetImportRecord | null> { const result = await this.db.query('select * from asset_imports where project_id = $1 and id = $2', [projectId, id]); return result.rows[0] ? map(result.rows[0] as Record<string, unknown>) : null; }
  async list(projectId: string): Promise<AssetImportRecord[]> { const result = await this.db.query('select * from asset_imports where project_id = $1 order by created_at desc, id desc', [projectId]); return result.rows.map((row) => map(row as Record<string, unknown>)); }

  async getWorkspace(workspaceId: string, id: string): Promise<AssetImportRecord | null> { const result = await this.db.query('select * from asset_imports where workspace_id = $1 and id = $2', [workspaceId, id]); return result.rows[0] ? map(result.rows[0] as Record<string, unknown>) : null; }
  async listWorkspace(workspaceId: string): Promise<AssetImportRecord[]> { const result = await this.db.query('select * from asset_imports where workspace_id = $1 order by created_at desc, id desc', [workspaceId]); return result.rows.map((row) => map(row as Record<string, unknown>)); }

  async attachJob(projectId: string, id: string, jobId: string): Promise<AssetImportRecord> {
    const result = await this.db.query("update asset_imports set job_id = $3, state = 'QUEUED', updated_at = now() where project_id = $1 and id = $2 and state = 'STAGED' and job_id is null returning *", [projectId, id, jobId]);
    if (result.rows[0]) return map(result.rows[0] as Record<string, unknown>);
    const current = await this.get(projectId, id); if (current?.state === 'QUEUED' && current.jobId === jobId) return current;
    throw new Error('Asset import can only attach a Job from STAGED');
  }
  async attachWorkspaceJob(workspaceId: string, id: string, jobId: string): Promise<AssetImportRecord> {
    const result = await this.db.query("update asset_imports set job_id = $3, state = 'QUEUED', updated_at = now() where workspace_id = $1 and id = $2 and state = 'STAGED' and job_id is null returning *", [workspaceId, id, jobId]);
    if (result.rows[0]) return map(result.rows[0] as Record<string, unknown>);
    const current = await this.getWorkspace(workspaceId, id); if (current?.state === 'QUEUED' && current.jobId === jobId) return current;
    throw new Error('Asset import can only attach a Job from STAGED');
  }

  async markProcessing(projectId: string, id: string): Promise<AssetImportRecord> { const result = await this.db.query("update asset_imports set state = 'PROCESSING', updated_at = now() where project_id = $1 and id = $2 and state = 'QUEUED' returning *", [projectId, id]); if (!result.rows[0]) throw new Error('Asset import must be QUEUED before PROCESSING'); return map(result.rows[0] as Record<string, unknown>); }
  async markWorkspaceProcessing(workspaceId: string, id: string): Promise<AssetImportRecord> { const result = await this.db.query("update asset_imports set state = 'PROCESSING', updated_at = now() where workspace_id = $1 and id = $2 and state = 'QUEUED' returning *", [workspaceId, id]); if (!result.rows[0]) throw new Error('Asset import must be QUEUED before PROCESSING'); return map(result.rows[0] as Record<string, unknown>); }

  async complete(projectId: string, id: string, input: { outputAssetId: string; state: 'READY' | 'DEDUPED' }, transaction?: AssetImportTransaction): Promise<AssetImportRecord> {
    const db = transaction || this.db;
    const result = await db.query("update asset_imports set state = $3, output_asset_id = $4, updated_at = now() where project_id = $1 and id = $2 and state = 'PROCESSING' returning *", [projectId, id, input.state, input.outputAssetId]);
    if (result.rows[0]) return map(result.rows[0] as Record<string, unknown>);
    const current = await this.get(projectId, id); if (current?.state === input.state && current.outputAssetId === input.outputAssetId) return current;
    throw new Error('Asset import must be PROCESSING before terminal completion');
  }
  async completeWorkspace(workspaceId: string, id: string, input: { outputAssetId: string; state: 'READY' | 'DEDUPED' }, transaction?: AssetImportTransaction): Promise<AssetImportRecord> {
    const db = transaction || this.db;
    const result = await db.query("update asset_imports set state = $3, output_asset_id = $4, updated_at = now() where workspace_id = $1 and id = $2 and state = 'PROCESSING' returning *", [workspaceId, id, input.state, input.outputAssetId]);
    if (result.rows[0]) return map(result.rows[0] as Record<string, unknown>);
    const current = await this.getWorkspace(workspaceId, id); if (current?.state === input.state && current.outputAssetId === input.outputAssetId) return current;
    throw new Error('Asset import must be PROCESSING before terminal completion');
  }

  async fail(projectId: string, id: string, input: { code: string; message: string }, transaction?: AssetImportTransaction): Promise<AssetImportRecord> { return this.terminal(projectId, id, 'FAILED', input.code, input.message, transaction); }
  async cancel(projectId: string, id: string, transaction?: AssetImportTransaction): Promise<AssetImportRecord> { return this.terminal(projectId, id, 'CANCELLED', null, null, transaction); }
  async failWorkspace(workspaceId: string, id: string, input: { code: string; message: string }, transaction?: AssetImportTransaction): Promise<AssetImportRecord> { return this.terminalWorkspace(workspaceId, id, 'FAILED', input.code, input.message, transaction); }
  async cancelWorkspace(workspaceId: string, id: string, transaction?: AssetImportTransaction): Promise<AssetImportRecord> { return this.terminalWorkspace(workspaceId, id, 'CANCELLED', null, null, transaction); }
  private async terminal(projectId: string, id: string, state: 'FAILED' | 'CANCELLED', errorCode: string | null, errorMessage: string | null, transaction?: AssetImportTransaction): Promise<AssetImportRecord> { const db = transaction || this.db; const result = await db.query("update asset_imports set state = $3, error_code = $4, error_message = $5, updated_at = now() where project_id = $1 and id = $2 and state in ('STAGED', 'QUEUED', 'PROCESSING') returning *", [projectId, id, state, errorCode, errorMessage]); if (result.rows[0]) return map(result.rows[0] as Record<string, unknown>); const current = await this.get(projectId, id); if (current?.state === state) return current; throw new Error('Asset import is already terminal'); }
  private async terminalWorkspace(workspaceId: string, id: string, state: 'FAILED' | 'CANCELLED', errorCode: string | null, errorMessage: string | null, transaction?: AssetImportTransaction): Promise<AssetImportRecord> { const db = transaction || this.db; const result = await db.query("update asset_imports set state = $3, error_code = $4, error_message = $5, updated_at = now() where workspace_id = $1 and id = $2 and state in ('STAGED', 'QUEUED', 'PROCESSING') returning *", [workspaceId, id, state, errorCode, errorMessage]); if (result.rows[0]) return map(result.rows[0] as Record<string, unknown>); const current = await this.getWorkspace(workspaceId, id); if (current?.state === state) return current; throw new Error('Asset import is already terminal'); }
}
