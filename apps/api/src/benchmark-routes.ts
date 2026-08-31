import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BenchmarkService } from '../../../packages/modules/benchmark/src/index.js';
import type { ProjectService } from '../../../packages/modules/project/src/index.js';

const accountInput = z.object({
  platform: z.string().trim().min(1).max(100),
  accountName: z.string().trim().min(1).max(200),
  accountUrl: z.string().url().optional(),
  positioning: z.string().trim().min(1).max(20_000),
  category: z.string().trim().min(1).max(200),
  keywords: z.array(z.string().trim().min(1).max(200)).max(64),
  notes: z.string().max(20_000).optional(),
}).strict();
const contentInput = z.object({
  benchmarkAccountId: z.string().trim().min(1).max(200),
  platform: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(500),
  url: z.string().url().optional(),
  copy: z.string().trim().min(1).max(100_000),
  publishDate: z.string().datetime().optional(),
  metrics: z.record(z.string(), z.number().nonnegative()).optional(),
  notes: z.string().max(20_000).optional(),
}).strict();
const analyzeInput = z.object({ idempotencyKey: z.string().trim().min(1).max(200).optional(), correlationId: z.string().trim().min(1).max(200).optional() }).strict();

function fail(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, status: number, code: string, message: string): unknown {
  return reply.code(status).send({ error: { code, message, details: [] } });
}

export interface BenchmarkRouteDependencies { projects: ProjectService; benchmark: BenchmarkService; }

export function registerBenchmarkRoutes(app: FastifyInstance, deps: BenchmarkRouteDependencies): void {
  app.get('/api/v1/projects/:projectId/benchmarks/accounts', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await deps.projects.get(projectId))) return fail(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    return { items: await deps.benchmark.listAccounts(projectId) };
  });
  app.post('/api/v1/projects/:projectId/benchmarks/accounts', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    const parsed = accountInput.safeParse(request.body);
    if (!parsed.success) return fail(reply, 422, 'BENCHMARK_VALIDATION_ERROR', '对标账号信息不完整');
    if (!(await deps.projects.get(projectId))) return fail(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    try { const input = parsed.data; return reply.code(201).send(await deps.benchmark.createAccount({ projectId, platform: input.platform, accountName: input.accountName, positioning: input.positioning, category: input.category, keywords: input.keywords, ...(input.accountUrl ? { accountUrl: input.accountUrl } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}) })); }
    catch (error) { return fail(reply, 409, 'BENCHMARK_ACCOUNT_CREATE_FAILED', error instanceof Error ? error.message : '无法创建对标账号'); }
  });
  app.get('/api/v1/projects/:projectId/benchmarks/contents', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await deps.projects.get(projectId))) return fail(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    return { items: await deps.benchmark.listContents(projectId) };
  });
  app.post('/api/v1/projects/:projectId/benchmarks/contents', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    const parsed = contentInput.safeParse(request.body);
    if (!parsed.success) return fail(reply, 422, 'BENCHMARK_VALIDATION_ERROR', '对标内容信息不完整');
    if (!(await deps.projects.get(projectId))) return fail(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    try { const input = parsed.data; return reply.code(201).send(await deps.benchmark.createContent({ projectId, benchmarkAccountId: input.benchmarkAccountId, platform: input.platform, title: input.title, copy: input.copy, ...(input.url ? { url: input.url } : {}), ...(input.publishDate ? { publishDate: input.publishDate } : {}), ...(input.metrics ? { metrics: input.metrics } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}) })); }
    catch (error) { return fail(reply, 409, 'BENCHMARK_CONTENT_CREATE_FAILED', error instanceof Error ? error.message : '无法创建对标内容'); }
  });
  app.get('/api/v1/projects/:projectId/benchmarks/contents/:contentId/analyses', async (request, reply) => {
    const params = request.params as { projectId: string; contentId: string };
    if (!(await deps.benchmark.getContent(params.projectId, params.contentId))) return fail(reply, 404, 'BENCHMARK_CONTENT_NOT_FOUND', '对标内容不存在');
    return { items: await deps.benchmark.listAnalyses(params.projectId, params.contentId) };
  });
  app.post('/api/v1/projects/:projectId/benchmarks/contents/:contentId/analyze', async (request, reply) => {
    const params = request.params as { projectId: string; contentId: string };
    const parsed = analyzeInput.safeParse(request.body || {});
    if (!parsed.success) return fail(reply, 422, 'BENCHMARK_VALIDATION_ERROR', '分析请求不完整');
    if (!(await deps.benchmark.getContent(params.projectId, params.contentId))) return fail(reply, 404, 'BENCHMARK_CONTENT_NOT_FOUND', '对标内容不存在');
    try {
      const job = await deps.benchmark.createAnalysisJob({ projectId: params.projectId, benchmarkContentId: params.contentId, correlationId: parsed.data.correlationId || `api-${randomUUID()}`, idempotencyKey: parsed.data.idempotencyKey || `benchmark-${params.contentId}-${Date.now()}` });
      return reply.code(202).send({ jobId: job.id, projectId: job.projectId, type: job.type, state: job.state });
    } catch (error) { return fail(reply, 409, 'BENCHMARK_JOB_CONFLICT', error instanceof Error ? error.message : '无法创建分析任务'); }
  });
  app.post('/api/v1/projects/:projectId/benchmarks/contents/:contentId/reference', async (request, reply) => {
    const params = request.params as { projectId: string; contentId: string };
    try { await deps.benchmark.attach(params.projectId, params.contentId); return reply.code(204).send(); }
    catch (error) { return fail(reply, 404, 'BENCHMARK_CONTENT_NOT_FOUND', error instanceof Error ? error.message : '对标内容不存在'); }
  });
  app.get('/api/v1/projects/:projectId/benchmarks/references', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await deps.projects.get(projectId))) return fail(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    return { items: await deps.benchmark.listReferences(projectId) };
  });
}
