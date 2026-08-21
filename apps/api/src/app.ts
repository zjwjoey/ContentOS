import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { ProjectService } from '../../../packages/modules/project/src/index.js';
import { serializeError } from '../../../packages/shared/src/errors.js';

const projectInput = z.object({ name: z.string().trim().min(1).max(200), metadata: z.record(z.string(), z.unknown()).optional() });

export async function buildApi(db: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const projects = new ProjectService(db);
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
  app.setErrorHandler((error, _request, reply) => reply.code(500).send({ error: serializeError(error, 'InfrastructureError', 'api') }));
  return app;
}
