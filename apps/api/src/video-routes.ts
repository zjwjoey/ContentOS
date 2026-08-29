import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssetCatalogService } from '../../../packages/modules/asset/src/index.js';
import type { ApprovalService } from '../../../packages/modules/approval/src/index.js';
import type { DirectorV1Service } from '../../../packages/modules/director/src/index.js';
import type { DirectorVideoService, VideoProjectReadService } from '../../../packages/modules/video/src/index.js';
import type { JobService } from '../../../packages/modules/job/src/index.js';
import type { ProjectService } from '../../../packages/modules/project/src/index.js';
import type { AssetSummaryV0 } from '../../../packages/contracts/src/index.js';

const videoJobInput = z.object({
  targetDurationMs: z.number().int().positive().optional(),
  voiceAssetId: z.string().trim().min(1).optional(),
  subtitleText: z.string().max(20_000).optional(),
  seed: z.number().int().optional(),
  videoAssetIds: z.array(z.string().trim().min(1)).min(1).max(64),
});
const legacyVideoJobInput = videoJobInput.partial();

export interface VideoRouteDependencies {
  projects: ProjectService;
  director: DirectorV1Service;
  videoFromDirector: DirectorVideoService;
  videoRead: VideoProjectReadService;
  assets: AssetCatalogService;
  approvals: ApprovalService;
  jobs: JobService;
}

function projectIdOf(request: { params: unknown }): string { return (request.params as { projectId: string }).projectId; }
function safeAsset(asset: AssetSummaryV0): AssetSummaryV0 { return asset; }
function videoOptions(input: z.infer<typeof videoJobInput>): { videoAssetIds: string[]; targetDurationMs?: number; voiceAssetId?: string; subtitleText?: string; seed?: number } {
  return {
    videoAssetIds: input.videoAssetIds,
    ...(input.targetDurationMs !== undefined ? { targetDurationMs: input.targetDurationMs } : {}),
    ...(input.voiceAssetId !== undefined ? { voiceAssetId: input.voiceAssetId } : {}),
    ...(input.subtitleText !== undefined ? { subtitleText: input.subtitleText } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
}
function legacyVideoOptions(input: z.infer<typeof legacyVideoJobInput>): { videoAssetIds?: string[]; targetDurationMs?: number; voiceAssetId?: string; subtitleText?: string; seed?: number } {
  return {
    ...(input.videoAssetIds !== undefined ? { videoAssetIds: input.videoAssetIds } : {}),
    ...(input.targetDurationMs !== undefined ? { targetDurationMs: input.targetDurationMs } : {}),
    ...(input.voiceAssetId !== undefined ? { voiceAssetId: input.voiceAssetId } : {}),
    ...(input.subtitleText !== undefined ? { subtitleText: input.subtitleText } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
}

export function registerVideoRoutes(app: FastifyInstance, dependencies: VideoRouteDependencies): void {
  const { projects, director, videoFromDirector, videoRead, assets, approvals, jobs } = dependencies;

  app.get('/api/v1/projects/:projectId/video', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const [pair, projectAssets, history, currentRender, job] = await Promise.all([
      director.getCurrentVideoInput(projectId),
      assets.listProjectAssets(projectId),
      videoRead.listRenderHistory(projectId),
      videoRead.getCurrentRender(projectId),
      videoRead.getLatestVideoJob(projectId),
    ]);
    const sourceAssets = projectAssets.filter((asset) => asset.lifecycle === 'READY' && asset.kind === 'VIDEO').map(safeAsset);
    const voiceAssets = projectAssets.filter((asset) => asset.lifecycle === 'READY' && asset.kind === 'AUDIO').map(safeAsset);
    const current = currentRender ? { ...currentRender, status: 'SUCCEEDED' } : null;
    const approval = currentRender ? await approvals.getCurrent(projectId, 'RENDER', currentRender.renderId, currentRender.outputAssetId) : null;
    return {
      schemaVersion: 'VIDEO_WORKSPACE_V0', projectId,
      director: { ...(pair?.brief ? { briefId: pair.brief.id } : {}), ...(pair?.script ? { scriptRevisionId: pair.script.id } : {}), ...(pair?.storyboard ? { storyboardRevisionId: pair.storyboard.id } : {}), ready: Boolean(pair?.script?.status === 'ACCEPTED' && pair?.storyboard?.status === 'APPROVED' && pair.storyboard.scriptRevisionId === pair.script.id) },
      sourceAssets, voiceAssets, currentRender: current,
      renderHistory: history.map(({ jobId: _jobId, ...item }) => item), job,
      approval: approval ? { targetType: approval.targetType, targetId: approval.targetId, targetRevisionId: approval.targetRevisionId, status: approval.status } : null,
    };
  });

  app.post('/api/v1/projects/:projectId/video/jobs', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = videoJobInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Video Job input', details: parsed.error.issues } });
    const selected = await assets.listReadySourceAssets(projectId, parsed.data.videoAssetIds, 'VIDEO');
    if (selected.length !== new Set(parsed.data.videoAssetIds).size) return reply.code(422).send({ error: { code: 'VIDEO_SOURCE_ASSET_INVALID', message: 'Every selected source video must be READY and owned by this project', details: [] } });
    if (parsed.data.voiceAssetId && !(await assets.getReadySourceAsset(projectId, parsed.data.voiceAssetId, 'AUDIO'))) return reply.code(422).send({ error: { code: 'VIDEO_VOICE_ASSET_INVALID', message: 'The selected voice asset must be READY and owned by this project', details: [] } });
    try {
      return reply.code(201).send(await videoFromDirector.createVideoJob(projectId, videoOptions(parsed.data)));
    } catch (error) {
      return reply.code(409).send({ error: { code: 'DIRECTOR_VIDEO_CONFLICT', message: error instanceof Error ? error.message : 'Director to Video conflict', details: [] } });
    }
  });

  app.post('/api/v1/projects/:projectId/video/jobs/:jobId/cancel', async (request, reply) => {
    const projectId = projectIdOf(request); const jobId = (request.params as { jobId: string }).jobId;
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const job = await jobs.get(jobId);
    if (!job || job.projectId !== projectId || job.type !== 'VIDEO_RENDER') return reply.code(404).send({ error: { code: 'VIDEO_JOB_NOT_FOUND', message: 'Video Job not found for this project', details: [] } });
    await jobs.requestCancel(jobId);
    return { id: jobId, state: (await jobs.get(jobId))?.state || 'CANCELLED' };
  });

  // Compatibility alias kept for existing Director callers while the product route is standardized.
  app.post('/api/v1/projects/:id/video-jobs/from-director', async (request, reply) => {
    const projectId = (request.params as { id: string }).id;
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = legacyVideoJobInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Video Job input', details: parsed.error.issues } });
    try {
      return reply.code(201).send(await videoFromDirector.createVideoJob(projectId, legacyVideoOptions(parsed.data)));
    } catch (error) {
      return reply.code(409).send({ error: { code: 'DIRECTOR_VIDEO_CONFLICT', message: error instanceof Error ? error.message : 'Director to Video conflict', details: [] } });
    }
  });
}
