import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { ProjectService } from '../../../packages/modules/project/src/index.js';
import { DirectorService } from '../../../packages/modules/director/src/index.js';
import type { DirectorPlanV0 } from '../../../packages/contracts/src/index.js';
import { serializeError } from '../../../packages/shared/src/errors.js';

const projectInput = z.object({ name: z.string().trim().min(1).max(200), metadata: z.record(z.string(), z.unknown()).optional() });
const directorInput = z.object({ seed: z.number().int(), brief: z.object({ topic: z.string().trim().min(1), audience: z.string().trim().min(1), objective: z.string().trim().min(1), tone: z.string().trim().min(1) }), storyboard: z.array(z.object({ id: z.string().trim().min(1), title: z.string().trim().min(1), narration: z.string().trim().min(1), visualIntent: z.string().trim().min(1), durationMs: z.number().int().positive(), sourceAssetIds: z.array(z.string()) })).min(1), provenance: z.object({ author: z.string().trim().min(1), source: z.enum(['manual', 'ai-draft']), promptVersion: z.string().optional(), modelProfile: z.string().optional() }) });
function directorPlan(projectId: string, input: z.infer<typeof directorInput>): DirectorPlanV0 {
  return { schemaVersion: 'DIRECTOR_PLAN_V0', projectId, seed: input.seed, brief: input.brief, storyboard: input.storyboard, provenance: { author: input.provenance.author, source: input.provenance.source, ...(input.provenance.promptVersion ? { promptVersion: input.provenance.promptVersion } : {}), ...(input.provenance.modelProfile ? { modelProfile: input.provenance.modelProfile } : {}) } };
}

export async function buildApi(db: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const projects = new ProjectService(db);
  const director = new DirectorService(db, projects);
  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/api/v1/projects', async (request, reply) => {
    const parsed = projectInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid project input', details: parsed.error.issues } });
    const result = await projects.create(parsed.data.name, parsed.data.metadata || {});
    return reply.code(201).send(result);
  });
  app.get('/api/v1/projects/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const result = await projects.get(id);
    if (!result) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    return result;
  });
  app.get('/api/v1/projects', async () => ({ items: await projects.list() }));
  app.get('/api/v1/projects/:id/assets', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const project = await projects.get(id);
    if (!project) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const assets = await db.query('select a.* from assets a join project_assets pa on pa.asset_id = a.id where pa.project_id = $1 order by a.created_at', [id]);
    return { items: assets.rows };
  });
  app.post('/api/v1/projects/:id/director-plans', async (request, reply) => {
    const projectId = (request.params as { id: string }).id;
    const parsed = directorInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Director plan', details: parsed.error.issues } });
    const plan = directorPlan(projectId, parsed.data);
    try { return reply.code(201).send(await director.createDraft(projectId, plan)); }
    catch (error) { return reply.code(404).send({ error: { code: 'DIRECTOR_PROJECT_NOT_FOUND', message: error instanceof Error ? error.message : 'Project not found', details: [] } }); }
  });
  app.get('/api/v1/projects/:id/director-plans/current', async (request, reply) => {
    const projectId = (request.params as { id: string }).id;
    const current = await director.getCurrent(projectId);
    if (!current) return reply.code(404).send({ error: { code: 'DIRECTOR_PLAN_NOT_FOUND', message: 'No approved Director plan', details: [] } });
    return current;
  });
  app.post('/api/v1/projects/:id/director-plans/:revision/revise', async (request, reply) => {
    const params = request.params as { id: string; revision: string };
    const parsed = directorInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Director plan', details: parsed.error.issues } });
    const plan = directorPlan(params.id, parsed.data);
    try { return reply.code(201).send(await director.revise(params.id, Number(params.revision), plan)); }
    catch (error) { return reply.code(409).send({ error: { code: 'DIRECTOR_REVISION_CONFLICT', message: error instanceof Error ? error.message : 'Revision conflict', details: [] } }); }
  });
  app.post('/api/v1/projects/:id/director-plans/:revision/accept', async (request, reply) => {
    const params = request.params as { id: string; revision: string };
    try { return await director.accept(params.id, Number(params.revision)); }
    catch (error) { return reply.code(409).send({ error: { code: 'DIRECTOR_REVISION_CONFLICT', message: error instanceof Error ? error.message : 'Revision conflict', details: [] } }); }
  });
  app.post('/api/v1/projects/:id/director-plans/:revision/approve', async (request, reply) => {
    const params = request.params as { id: string; revision: string };
    try { return await director.approveStoryboard(params.id, Number(params.revision)); }
    catch (error) { return reply.code(409).send({ error: { code: 'DIRECTOR_REVISION_CONFLICT', message: error instanceof Error ? error.message : 'Revision conflict', details: [] } }); }
  });
  app.setErrorHandler((error, _request, reply) => reply.code(500).send({ error: serializeError(error, 'InfrastructureError', 'api') }));
  return app;
}
