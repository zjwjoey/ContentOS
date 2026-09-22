import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PRODUCTION_RUN_STAGES, PRODUCTION_STEP_STATUSES, type ProductionRunStage, type ProductionStepStatus } from '../../../packages/contracts/src/index.js';
import type { ProductionRunService } from '../../../packages/modules/production-run/src/index.js';
import type { ProjectService } from '../../../packages/modules/project/src/index.js';

const createInput = z.object({
  title: z.string().trim().min(1).max(200),
  digitalHumanMode: z.enum(['NONE', 'INTRO_ONLY', 'OUTRO_ONLY', 'FULL_TALKING_HEAD', 'CUSTOM']).optional(),
  approvalRequired: z.boolean().optional(), approvalBypassed: z.boolean().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
const stepInput = z.object({
  status: z.enum(PRODUCTION_STEP_STATUSES), inputRefs: z.record(z.string(), z.unknown()).optional(), outputRefs: z.record(z.string(), z.unknown()).optional(),
  errorCode: z.string().trim().max(200).nullable().optional(), errorMessage: z.string().trim().max(2000).nullable().optional(),
}).strict();
const stageInput = z.object({ stage: z.enum(PRODUCTION_RUN_STAGES) }).strict();

export function registerProductionRunRoutes(app: FastifyInstance, dependencies: { projects: ProjectService; productionRuns: ProductionRunService }): void {
  const { projects, productionRuns } = dependencies;
  const projectExists = async (projectId: string, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    if (!(await projects.get(projectId))) { reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } }); return false; }
    return true;
  };
  const failure = (reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) => reply.code(409).send({ error: { code: error instanceof Error ? error.message.split(':')[0] : 'PRODUCTION_RUN_CONFLICT', message: error instanceof Error ? error.message : 'Production run conflict', details: [] } });

  app.get('/api/v1/projects/:projectId/production-runs', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await projectExists(projectId, reply))) return;
    return { items: await productionRuns.list(projectId) };
  });
  app.post('/api/v1/projects/:projectId/production-runs', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await projectExists(projectId, reply))) return;
    const parsed = createInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid production run input', details: parsed.error.issues } });
    try {
      return reply.code(201).send(await productionRuns.create({ projectId, title: parsed.data.title, ...(parsed.data.digitalHumanMode ? { digitalHumanMode: parsed.data.digitalHumanMode } : {}), ...(parsed.data.approvalRequired !== undefined ? { approvalRequired: parsed.data.approvalRequired } : {}), ...(parsed.data.approvalBypassed !== undefined ? { approvalBypassed: parsed.data.approvalBypassed } : {}), ...(parsed.data.idempotencyKey ? { idempotencyKey: parsed.data.idempotencyKey } : {}), ...(parsed.data.metadata ? { metadata: parsed.data.metadata } : {}) }));
    } catch (error) { return failure(reply, error); }
  });
  app.get('/api/v1/projects/:projectId/production-runs/:runId', async (request, reply) => {
    const params = request.params as { projectId: string; runId: string };
    if (!(await projectExists(params.projectId, reply))) return;
    const result = await productionRuns.get(params.projectId, params.runId);
    if (!result) return reply.code(404).send({ error: { code: 'PRODUCTION_RUN_NOT_FOUND', message: 'Production run not found', details: [] } });
    return result;
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/steps/:stage', async (request, reply) => {
    const params = request.params as { projectId: string; runId: string; stage: string };
    const stage = z.enum(PRODUCTION_RUN_STAGES).safeParse(params.stage);
    const parsed = stepInput.safeParse(request.body);
    if (!stage.success || !parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid production step input', details: [...(stage.success ? [] : stage.error.issues), ...(parsed.success ? [] : parsed.error.issues)] } });
    try { return await productionRuns.updateStep(params.projectId, params.runId, { stage: stage.data as ProductionRunStage, status: parsed.data.status as ProductionStepStatus, ...(parsed.data.inputRefs ? { inputRefs: parsed.data.inputRefs } : {}), ...(parsed.data.outputRefs ? { outputRefs: parsed.data.outputRefs } : {}), ...(parsed.data.errorCode !== undefined ? { errorCode: parsed.data.errorCode } : {}), ...(parsed.data.errorMessage !== undefined ? { errorMessage: parsed.data.errorMessage } : {}) }); } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/retry', async (request, reply) => {
    const params = request.params as { projectId: string; runId: string }; const parsed = stageInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid retry input', details: parsed.error.issues } });
    try { return await productionRuns.retry(params.projectId, params.runId, parsed.data.stage); } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/cancel', async (request, reply) => {
    const params = request.params as { projectId: string; runId: string };
    try { return await productionRuns.cancel(params.projectId, params.runId); } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/reconcile', async (request, reply) => {
    const params = request.params as { projectId: string; runId: string };
    try { return await productionRuns.reconcile(params.projectId, params.runId); } catch (error) { return failure(reply, error); }
  });
}
