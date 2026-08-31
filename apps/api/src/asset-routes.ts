import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AssetImportKind } from '../../../packages/contracts/src/index.js';
import { AssetCatalogService, AssetImportService } from '../../../packages/modules/asset/src/index.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { ProjectService } from '../../../packages/modules/project/src/index.js';
import { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { z } from 'zod';

export interface AssetRouteDependencies { projects: ProjectService; imports: AssetImportService; assets: AssetCatalogService; jobs: JobService; storage: LocalStorageProvider; maxUploadBytes: number; }

function error(reply: { code: (status: number) => { send: (value: unknown) => unknown } }, status: number, code: string, message: string): unknown { return reply.code(status).send({ error: { code, message, details: [] } }); }

export function registerAssetRoutes(app: FastifyInstance, dependencies: AssetRouteDependencies): void {
  app.post('/api/v1/projects/:projectId/asset-imports', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await dependencies.projects.get(projectId))) return error(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    const part = await request.file();
    if (!part) return error(reply, 422, 'UPLOAD_REQUIRED', 'An asset file is required');
    const kind: AssetImportKind | null = part.mimetype.startsWith('video/') ? 'VIDEO' : part.mimetype.startsWith('audio/') ? 'AUDIO' : null;
    if (!kind) { await part.file.resume(); return error(reply, 422, 'UNSUPPORTED_MEDIA_TYPE', 'Only video and audio uploads are supported'); }
    let staged: Awaited<ReturnType<LocalStorageProvider['stageUpload']>> | undefined;
    let importId: string | undefined;
    let jobId: string | undefined;
    try {
      staged = await dependencies.storage.stageUpload(part.filename, part.file, dependencies.maxUploadBytes);
      if ((part.file as typeof part.file & { truncated?: boolean }).truncated) throw new Error('UPLOAD_TOO_LARGE');
      const record = await dependencies.imports.createStaged({ projectId, originalName: staged.originalName, kind, byteSize: staged.byteSize, stagedPath: staged.stagedPath, correlationId: randomUUID() });
      importId = record.id;
      const job = await dependencies.jobs.createIdempotent({ id: `job-${randomUUID()}`, type: 'ASSET_IMPORT', projectId, payload: { schemaVersion: 'ASSET_IMPORT_V0', projectId, importId: record.id, correlationId: record.correlationId }, idempotencyKey: `asset-import:${record.id}`, maxAttempts: 3 });
      jobId = job.id;
      await dependencies.imports.attachJob(projectId, record.id, job.id);
      return reply.code(202).send({ import: await dependencies.imports.get(projectId, record.id), jobId: job.id });
    } catch (cause) {
      if (importId) { try { await dependencies.imports.fail(projectId, importId, { code: cause instanceof Error ? cause.message.slice(0, 80) : 'ASSET_IMPORT_FAILED', message: 'Asset import could not be queued' }); } catch { /* preserve original failure */ } }
      if (jobId) { try { await dependencies.jobs.requestCancel(jobId); } catch { /* preserve original failure */ } }
      if (staged) await dependencies.storage.removeStaged(staged.stagedPath);
      const message = cause instanceof Error && cause.message === 'UNSUPPORTED_MEDIA_TYPE' ? 'Only video and audio uploads are supported' : cause instanceof Error && cause.message === 'UPLOAD_TOO_LARGE' ? 'Upload exceeds the configured size limit' : cause instanceof Error && cause.message === 'EMPTY_UPLOAD' ? 'Upload cannot be empty' : 'Asset upload failed';
      return error(reply, message === 'Asset upload failed' ? 422 : 413, cause instanceof Error && cause.message === 'UNSUPPORTED_MEDIA_TYPE' ? 'UNSUPPORTED_MEDIA_TYPE' : cause instanceof Error && cause.message === 'UPLOAD_TOO_LARGE' ? 'UPLOAD_TOO_LARGE' : cause instanceof Error && cause.message === 'EMPTY_UPLOAD' ? 'EMPTY_UPLOAD' : 'ASSET_IMPORT_FAILED', message);
    }
  });

  app.get('/api/v1/projects/:projectId/asset-imports', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await dependencies.projects.get(projectId))) return error(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    return { items: await dependencies.imports.list(projectId) };
  });

  app.get('/api/v1/projects/:projectId/assets', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await dependencies.projects.get(projectId))) return error(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    const query = request.query as { kind?: string; tag?: string; q?: string };
    return { items: await dependencies.assets.listProjectAssets(projectId, { ...(query.kind ? { kind: query.kind } : {}), ...(query.tag ? { tag: query.tag } : {}), ...(query.q ? { query: query.q } : {}) }) };
  });

  app.patch('/api/v1/projects/:projectId/assets/:assetId/tags', async (request, reply) => {
    const params = request.params as { projectId: string; assetId: string };
    const parsed = z.object({ tags: z.array(z.string().trim().min(1).max(100)).max(64).optional(), category: z.string().max(200).optional(), notes: z.string().max(20_000).optional() }).strict().safeParse(request.body);
    if (!parsed.success) return error(reply, 422, 'ASSET_TAG_VALIDATION_ERROR', '素材标签信息不合法');
    const input = parsed.data; const asset = await dependencies.assets.updateTags(params.projectId, params.assetId, { ...(input.tags ? { tags: input.tags } : {}), ...(input.category !== undefined ? { category: input.category } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}) });
    return asset ? asset : error(reply, 404, 'ASSET_NOT_FOUND', 'Asset not found for project');
  });

  app.get('/api/v1/projects/:projectId/assets/:assetId/content', async (request, reply) => {
    const params = request.params as { projectId: string; assetId: string };
    const asset = await dependencies.assets.getReadyAssetContent(params.projectId, params.assetId);
    if (!asset) return error(reply, 404, 'ASSET_NOT_FOUND', 'Ready asset not found');
    reply.header('content-type', asset.metadata.format === 'wav' ? 'audio/wav' : asset.kind === 'AUDIO' ? 'audio/mpeg' : 'video/mp4');
    reply.header('content-length', asset.byteSize);
    reply.header('accept-ranges', 'bytes');
    reply.header('etag', `"${asset.checksum}"`);
    return reply.send(createReadStream(dependencies.storage.objectPath(asset.storageKey)));
  });
}
