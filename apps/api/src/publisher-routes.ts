import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JobService } from '../../../packages/modules/job/src/index.js';
import type { ProjectService } from '../../../packages/modules/project/src/index.js';
import type { ApprovalService } from '../../../packages/modules/approval/src/index.js';
import type { AssetCatalogService } from '../../../packages/modules/asset/src/index.js';
import type { PublisherRequestAggregate, PublisherService } from '../../../packages/modules/publisher/src/index.js';

const capabilityProfile = z.object({
  platformId: z.string().trim().min(1).max(80),
  mediaTypes: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
  scheduling: z.boolean(),
  requiresHumanConfirmation: z.boolean(),
});

const accountInput = z.object({
  platformId: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(200),
  credentialRef: z.string().trim().min(1).max(200).optional(),
  profileKey: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['UNVERIFIED', 'READY', 'REAUTH_REQUIRED', 'SUSPENDED', 'DISABLED']).optional(),
  capabilitySnapshot: capabilityProfile,
});

const requestInput = z.object({
  accountId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(200),
  correlationId: z.string().trim().min(1).max(200),
  revision: z.object({
    assetId: z.string().trim().min(1),
    assetChecksum: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000),
    desiredPublishAt: z.string().datetime().nullable(),
    createdBy: z.string().trim().min(1).max(200),
  }),
});

export interface PublisherRouteDependencies {
  projects: ProjectService;
  publisher: PublisherService;
  approvals: ApprovalService;
  assets: AssetCatalogService;
  jobs: JobService;
}

function projectIdOf(request: { params: unknown }): string { return (request.params as { projectId: string }).projectId; }
function requestIdOf(request: { params: unknown }): string { return (request.params as { requestId: string }).requestId; }
function safeAccount<T extends { credentialRef: string; profileKey: string }>(account: T): Omit<T, 'credentialRef' | 'profileKey'> {
  const { credentialRef: _credentialRef, profileKey: _profileKey, ...safe } = account;
  return safe;
}
function safeAggregate(aggregate: PublisherRequestAggregate): Omit<PublisherRequestAggregate, 'attempts'> & { attempts: Array<Omit<PublisherRequestAggregate['attempts'][number], 'diagnostics'>> } {
  return { ...aggregate, attempts: aggregate.attempts.map(({ diagnostics: _diagnostics, ...safeAttempt }) => safeAttempt) };
}

export function registerPublisherRoutes(app: FastifyInstance, dependencies: PublisherRouteDependencies): void {
  const { projects, publisher, approvals, assets, jobs } = dependencies;

  app.get('/api/v1/projects/:projectId/publisher/accounts', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    return { items: (await publisher.listAccounts(projectId)).map(safeAccount) };
  });

  app.post('/api/v1/projects/:projectId/publisher/accounts', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = accountInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Publisher account input', details: parsed.error.issues } });
    const { status, credentialRef, profileKey, ...input } = parsed.data;
    if (input.platformId !== 'fake-platform' && (!credentialRef || !profileKey)) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'A non-Fake account requires server-managed references', details: [] } });
    const createInput = { projectId, ...input, credentialRef: credentialRef || `fake-credential:${randomUUID()}`, profileKey: profileKey || `fake-profile-${randomUUID()}`, ...(status ? { status } : {}) };
    try { return reply.code(201).send(safeAccount(await publisher.createAccount(createInput))); }
    catch (error) { return reply.code(409).send({ error: { code: 'PUBLISHER_ACCOUNT_CONFLICT', message: error instanceof Error ? error.message : 'Publisher account conflict', details: [] } }); }
  });

  app.get('/api/v1/projects/:projectId/publisher/assets', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    return { items: await assets.listPublishable(projectId) };
  });

  app.get('/api/v1/projects/:projectId/publisher/requests', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    return { items: await publisher.listRequests(projectId) };
  });

  app.post('/api/v1/projects/:projectId/publisher/requests', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = requestInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Publisher request input', details: parsed.error.issues } });
    const asset = await assets.getPublishableAsset(projectId, parsed.data.revision.assetId);
    if (!asset || asset.checksum !== parsed.data.revision.assetChecksum) return reply.code(422).send({ error: { code: 'PUBLISHER_ASSET_INVALID', message: 'A READY VIDEO_RENDER Asset owned by this project and matching the checksum is required', details: [] } });
    try { return reply.code(201).send(await publisher.createRequest({ projectId, ...parsed.data })); }
    catch (error) { return reply.code(409).send({ error: { code: 'PUBLISHER_REQUEST_CONFLICT', message: error instanceof Error ? error.message : 'Publisher request conflict', details: [] } }); }
  });

  app.get('/api/v1/projects/:projectId/publisher/requests/:requestId', async (request, reply) => {
    const projectId = projectIdOf(request);
    const requestId = requestIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const aggregate = await publisher.getRequestAggregate(projectId, requestId);
    if (!aggregate) return reply.code(404).send({ error: { code: 'PUBLISHER_REQUEST_NOT_FOUND', message: 'Publisher request not found', details: [] } });
    return safeAggregate(aggregate);
  });

  app.post('/api/v1/projects/:projectId/publisher/requests/:requestId/queue', async (request, reply) => {
    const projectId = projectIdOf(request);
    const requestId = requestIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const aggregate = await publisher.getRequestAggregate(projectId, requestId);
    if (!aggregate) return reply.code(404).send({ error: { code: 'PUBLISHER_REQUEST_NOT_FOUND', message: 'Publisher request not found', details: [] } });
    const approval = await approvals.getCurrent(projectId, 'PUBLISH', requestId, aggregate.revision.id);
    if (!approval || approval.status !== 'APPROVED') return reply.code(409).send({ error: { code: 'PUBLISH_APPROVAL_REQUIRED', message: 'An approved Publish revision is required before queueing', details: [] } });
    const idempotencyKey = `publisher:publish:${requestId}:${aggregate.revision.id}`;
    const jobId = `job-publish-${requestId}-${aggregate.revision.revision}`;
    const payload = await publisher.buildPublishJobPayload(projectId, requestId, jobId, null);
    const job = await jobs.createIdempotent({ id: jobId, type: 'PUBLISH', projectId, payload, idempotencyKey, maxAttempts: 3 });
    if (aggregate.request.status !== 'QUEUED') await publisher.transitionRequest(requestId, 'QUEUED');
    return reply.code(202).send({ jobId: job.id, requestId, state: job.state });
  });
}
