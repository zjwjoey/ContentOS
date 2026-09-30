import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IntelligentPlanningService } from '../../../packages/modules/intelligence/src/index.js';
import { ProjectService } from '../../../packages/modules/project/src/index.js';

const planInput = z.object({ assetIds: z.array(z.string().trim().min(1)).min(1), sentences: z.array(z.object({ id: z.string().trim().min(1), text: z.string().trim().min(1), durationMs: z.number().int().positive().optional() })).min(1), seed: z.number().int().optional(), targetDurationMs: z.number().int().positive(), minClipDurationMs: z.number().int().positive().optional(), maxClipDurationMs: z.number().int().positive().optional(), maxAssetReuse: z.number().int().positive().optional(), diversityWeight: z.number().min(0).max(1).optional() }).strict();

export function registerIntelligentPlanningRoutes(app: FastifyInstance, dependencies: { projects: ProjectService; planning: IntelligentPlanningService }): void {
  app.post('/api/v1/projects/:projectId/intelligence/plans', async (request, reply) => {
    const projectId = String((request.params as { projectId: string }).projectId);
    if (!(await dependencies.projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = planInput.safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid intelligent plan input', details: parsed.error.issues } });
    const input = parsed.data;
    try {
      return reply.code(201).send(await dependencies.planning.createPlan({ projectId, assetIds: input.assetIds, sentences: input.sentences.map((sentence) => ({ id: sentence.id, text: sentence.text, ...(sentence.durationMs === undefined ? {} : { durationMs: sentence.durationMs }) })), ...(input.seed === undefined ? {} : { seed: input.seed }), config: { schemaVersion: 'INTELLIGENT_PLANNER_CONFIG_V1', version: 'intelligent-planner-v1', targetDurationMs: input.targetDurationMs, minClipDurationMs: input.minClipDurationMs || 2_000, maxClipDurationMs: input.maxClipDurationMs || 5_000, maxAssetReuse: input.maxAssetReuse || 2, diversityWeight: input.diversityWeight ?? 0.8 } }));
    } catch (error) { const message = error instanceof Error ? error.message : 'Intelligent plan failed'; return reply.code(message.includes('NOT_FOUND') ? 404 : 422).send({ error: { code: message, message, details: [] } }); }
  });
  app.get('/api/v1/projects/:projectId/intelligence/plans/:planId', async (request, reply) => { const params = request.params as { projectId: string; planId: string }; const result = await dependencies.planning.getPlan(params.projectId, params.planId); return result ? result : reply.code(404).send({ error: { code: 'INTELLIGENT_PLAN_NOT_FOUND', message: 'Intelligent plan not found', details: [] } }); });
}
