import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import type { JobLeaseCancellationHandler, JobRecord, JobService } from '../../../packages/modules/job/src/index.js';
import { AssetImportService, AssetService } from '../../../packages/modules/asset/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { probeMedia } from '../../../packages/infrastructure/ffmpeg/src/index.js';

export interface AssetHandlerDeps { db: Pool; storage: LocalStorageProvider; assets: AssetService; imports: AssetImportService; jobs: JobService; ffprobePath: string; }

export function createAssetLeaseCancellationHandler(imports: AssetImportService, storage: LocalStorageProvider): JobLeaseCancellationHandler {
  return async (job, scope) => {
    if (job.type !== 'ASSET_IMPORT') return false;
    const payload = job.payload as { projectId?: string; workspaceId?: string; importId?: string };
    if (payload.projectId && payload.importId) await imports.cancel(payload.projectId, payload.importId, scope);
    if (payload.workspaceId && payload.importId) await imports.cancelWorkspace(payload.workspaceId, payload.importId, scope);
    if (payload.importId) { const record = payload.projectId ? await imports.get(payload.projectId, payload.importId) : payload.workspaceId ? await imports.getWorkspace(payload.workspaceId, payload.importId) : null; if (record) await storage.removeStaged(record.stagedPath); }
    return true;
  };
}

export function createAssetJobHandler(deps: AssetHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, attemptId, signal) => {
    const payload = job.payload as { schemaVersion?: string; projectId?: string; workspaceId?: string; importId?: string };
    const validOwner = (payload.projectId && payload.projectId === job.projectId && !payload.workspaceId) || (payload.workspaceId && payload.workspaceId === job.workspaceId && !payload.projectId);
    if (payload.schemaVersion !== 'ASSET_IMPORT_V0' || !validOwner || !payload.importId) throw Object.assign(new Error('Invalid Asset Import Job payload'), { code: 'ASSET_IMPORT_PAYLOAD_INVALID', retryable: false });
    const record = payload.projectId ? await deps.imports.get(payload.projectId, payload.importId) : await deps.imports.getWorkspace(payload.workspaceId!, payload.importId);
    if (!record) throw Object.assign(new Error('Asset import not found'), { code: 'ASSET_IMPORT_NOT_FOUND', retryable: false });
    if (record.state === 'READY' || record.state === 'DEDUPED') return { importId: record.id, outputAssetId: record.outputAssetId, state: record.state };
    if (record.projectId) await deps.imports.markProcessing(record.projectId, record.id); else await deps.imports.markWorkspaceProcessing(record.workspaceId, record.id);
    let prepared: Awaited<ReturnType<AssetService['prepareStagedUpload']>> | undefined;
    try {
      signal.throwIfAborted();
      const stagedPath = deps.storage.stagedPath(record.stagedPath);
      const bytes = await readFile(stagedPath);
      const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const probe = await probeMedia(stagedPath, deps.ffprobePath, signal);
      if (record.kind === 'VIDEO' && probe.width <= 0) throw Object.assign(new Error('Uploaded file is not a video'), { code: 'ASSET_KIND_MISMATCH', retryable: false });
      if (record.kind === 'AUDIO' && !probe.audio) throw Object.assign(new Error('Uploaded file is not audio'), { code: 'ASSET_KIND_MISMATCH', retryable: false });
      prepared = await deps.assets.prepareStagedUpload({ ...(record.projectId ? { projectId: record.projectId } : { workspaceId: record.workspaceId }), sourcePath: stagedPath, kind: record.kind, ...(record.workspaceId && record.kind === 'AUDIO' ? { role: 'VOICE' as const } : {}), stagedPath: record.stagedPath, originalName: record.originalName, checksum, byteSize: bytes.byteLength, probe });
      signal.throwIfAborted();
      const result = await deps.jobs.succeedWithCurrentAttempt(job.id, attemptId, async (scope) => {
        const output = await deps.assets.commitPrepared({ ...(record.projectId ? { projectId: record.projectId } : { workspaceId: record.workspaceId }), sourcePath: stagedPath, kind: record.kind, ...(record.workspaceId && record.kind === 'AUDIO' ? { role: 'VOICE' as const } : {}) }, prepared!, scope);
        const completed = record.projectId
          ? await deps.imports.complete(record.projectId, record.id, { outputAssetId: output.id, state: output.status === 'DEDUPED' ? 'DEDUPED' : 'READY' }, scope)
          : await deps.imports.completeWorkspace(record.workspaceId, record.id, { outputAssetId: output.id, state: output.status === 'DEDUPED' ? 'DEDUPED' : 'READY' }, scope);
        return { importId: completed.id, outputAssetId: output.id, state: completed.state };
      });
      if (result.executed) return result.value;
      return { importId: record.id, staleAttempt: true };
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : signal.aborted ? 'ASSET_IMPORT_CANCELLED' : 'ASSET_IMPORT_FAILED';
      if (signal.aborted) { await deps.jobs.cancelAttempt(job.id, attemptId, async (scope) => { if (record.projectId) await deps.imports.cancel(record.projectId, record.id, scope); else await deps.imports.cancelWorkspace(record.workspaceId, record.id, scope); }); throw error; }
      if (record.projectId) await deps.imports.fail(record.projectId, record.id, { code, message: error instanceof Error ? error.message.slice(0, 200) : 'Asset import failed' });
      else await deps.imports.failWorkspace(record.workspaceId, record.id, { code, message: error instanceof Error ? error.message.slice(0, 200) : 'Asset import failed' });
      throw error;
    } finally {
      if (prepared && !(await deps.storage.exists(prepared.storageKey))) await deps.storage.removeStaged(record.stagedPath);
      else if (!prepared) await deps.storage.removeStaged(record.stagedPath);
    }
  };
}
