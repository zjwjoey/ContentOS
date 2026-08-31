import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JobService } from '../../../packages/modules/job/src/index.js';
import type { ProjectService } from '../../../packages/modules/project/src/index.js';
import type { ApprovalService } from '../../../packages/modules/approval/src/index.js';
import type { AssetCatalogService } from '../../../packages/modules/asset/src/index.js';
import { fakeOutcomes, type FakeOutcome, type PublisherRequestAggregate, type PublisherService, type FakePublisherSimulationService } from '../../../packages/modules/publisher/src/index.js';

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
    hashtags: z.array(z.string().trim().min(1).max(100)).max(32).optional(),
    coverAssetId: z.string().trim().min(1).optional(),
    desiredPublishAt: z.string().datetime().nullable(),
    createdBy: z.string().trim().min(1).max(200),
  }),
});

const handoffInput = z.object({
  accountIds: z.array(z.string().trim().min(1)).min(1).max(20),
  assetId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000),
  hashtags: z.array(z.string().trim().min(1).max(100)).max(32).optional(),
  coverAssetId: z.string().trim().min(1).optional(),
  desiredPublishAt: z.string().datetime().nullable(),
  createdBy: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(200),
  correlationId: z.string().trim().min(1).max(200),
}).superRefine((value, context) => {
  if (new Set(value.accountIds).size !== value.accountIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['accountIds'], message: 'accountIds must not contain duplicates' });
});
const revisionEditInput = requestInput.shape.revision;

export interface PublisherRouteDependencies {
  projects: ProjectService;
  publisher: PublisherService;
  approvals: ApprovalService;
  assets: AssetCatalogService;
  jobs: JobService;
  fakeSimulations?: FakePublisherSimulationService;
  allowFakePublisherControls?: boolean;
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

async function refreshProjectPublishingStatus(projectId: string, projects: ProjectService, publisher: PublisherService, assets: AssetCatalogService): Promise<void> {
  const [summary, publishableAssets] = await Promise.all([publisher.getProjectSummary(projectId), assets.listPublishable(projectId)]);
  await projects.syncPublishingStatus(projectId, { hasPublishableAsset: publishableAssets.length > 0, publishedRequestCount: summary.statusCounts.PUBLISHED });
}

export function registerPublisherRoutes(app: FastifyInstance, dependencies: PublisherRouteDependencies): void {
  const { projects, publisher, approvals, assets, jobs, fakeSimulations, allowFakePublisherControls } = dependencies;

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

  app.get('/api/v1/projects/:projectId/publisher/summary', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    return publisher.getProjectSummary(projectId);
  });

  app.get('/api/v1/projects/:projectId/publisher/preflight', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const accounts = await publisher.listAccounts(projectId);
    const realAdaptersEnabled = process.env.PUBLISHER_REAL_ADAPTERS_ENABLED === '1' || process.env.PUBLISHER_REAL_ADAPTERS_ENABLED === 'true';
    const accountChecks = accounts.map((account) => ({ id: account.id, platformId: account.platformId, displayName: account.displayName, status: account.status, ready: account.status === 'READY', credentialReferenceConfigured: Boolean(account.credentialRef), sessionValidation: account.platformId === 'fake-platform' ? 'VALIDATED' : 'REQUIRED', requiresHumanAction: account.status === 'REAUTH_REQUIRED' || account.status === 'SUSPENDED' }));
    return { realAdaptersEnabled, publishMode: realAdaptersEnabled ? 'REAL_OR_FAKE_BY_ACCOUNT' : 'FAKE_ONLY', accounts: accountChecks, checks: { adapterRuntime: realAdaptersEnabled ? 'ENABLED_NOT_VALIDATED' : 'DISABLED', credentials: accountChecks.length > 0 && accountChecks.every((account) => account.credentialReferenceConfigured), accountReady: accountChecks.length > 0 && accountChecks.every((account) => account.ready && account.sessionValidation === 'VALIDATED'), humanActionRequired: accountChecks.some((account) => account.requiresHumanAction) } };
  });

  app.post('/api/v1/projects/:projectId/publisher/accounts/:accountId/validate', async (request, reply) => {
    const projectId = projectIdOf(request); const accountId = (request.params as { accountId: string }).accountId;
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const account = await publisher.getAccount(projectId, accountId);
    if (!account) return reply.code(404).send({ error: { code: 'PUBLISH_ACCOUNT_NOT_FOUND', message: 'Publisher account is not available', details: [] } });
    const idempotencyKey = `publisher:validate:${projectId}:${accountId}`;
    const job = await jobs.createIdempotent({ id: `job-publisher-validate-${accountId}`, type: 'PUBLISH_VALIDATE_ACCOUNT', projectId, payload: { schemaVersion: 'PUBLISH_VALIDATE_ACCOUNT_JOB_V1', projectId, accountId }, idempotencyKey, maxAttempts: 2 });
    return reply.code(202).send({ jobId: job.id, state: job.state, accountId, projectId });
  });

  app.get('/api/v1/projects/:projectId/publisher/requests', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    return { items: await publisher.listRequests(projectId) };
  });

  if (allowFakePublisherControls && fakeSimulations) {
    app.get('/api/v1/projects/:projectId/publisher/accounts/:accountId/fake-outcome', async (request, reply) => {
      const projectId = projectIdOf(request);
      const accountId = (request.params as { accountId: string }).accountId;
      if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
      try { return { outcome: await fakeSimulations.get(projectId, accountId) }; }
      catch { return reply.code(404).send({ error: { code: 'FAKE_ACCOUNT_NOT_FOUND', message: 'Fake Publisher account not found', details: [] } }); }
    });

    app.put('/api/v1/projects/:projectId/publisher/accounts/:accountId/fake-outcome', async (request, reply) => {
      const projectId = projectIdOf(request);
      const accountId = (request.params as { accountId: string }).accountId;
      if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
      const parsed = z.object({ outcome: z.enum(fakeOutcomes) }).safeParse(request.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Fake Publisher outcome', details: parsed.error.issues } });
      try { return { outcome: await fakeSimulations.set(projectId, accountId, parsed.data.outcome as FakeOutcome) }; }
      catch { return reply.code(404).send({ error: { code: 'FAKE_ACCOUNT_NOT_FOUND', message: 'Fake Publisher account not found', details: [] } }); }
    });
  }

  app.post('/api/v1/projects/:projectId/publisher/requests', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = requestInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Publisher request input', details: parsed.error.issues } });
    const asset = await assets.getPublishableAsset(projectId, parsed.data.revision.assetId);
    if (!asset || asset.checksum !== parsed.data.revision.assetChecksum) return reply.code(422).send({ error: { code: 'PUBLISHER_ASSET_INVALID', message: 'A READY VIDEO_RENDER Asset owned by this project and matching the checksum is required', details: [] } });
    if (parsed.data.revision.coverAssetId) { const cover = await assets.getProjectAsset(projectId, parsed.data.revision.coverAssetId); if (!cover || cover.lifecycle !== 'READY' || cover.kind !== 'VIDEO_RENDER') return reply.code(422).send({ error: { code: 'PUBLISHER_COVER_ASSET_INVALID', message: '封面 Asset 必须属于当前项目、处于 READY 且为支持的媒体类型', details: [] } }); }
    try {
      const revision = parsed.data.revision;
      const result = await publisher.createRequest({ projectId, accountId: parsed.data.accountId, idempotencyKey: parsed.data.idempotencyKey, correlationId: parsed.data.correlationId, revision: { assetId: revision.assetId, assetChecksum: revision.assetChecksum, title: revision.title, description: revision.description, hashtags: revision.hashtags || [], ...(revision.coverAssetId ? { coverAssetId: revision.coverAssetId } : {}), desiredPublishAt: revision.desiredPublishAt, createdBy: revision.createdBy } });
      await refreshProjectPublishingStatus(projectId, projects, publisher, assets);
      return reply.code(201).send(result);
    }
    catch (error) { return reply.code(409).send({ error: { code: 'PUBLISHER_REQUEST_CONFLICT', message: error instanceof Error ? error.message : 'Publisher request conflict', details: [] } }); }
  });

  app.post('/api/v1/projects/:projectId/publisher/handoff', async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = handoffInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid project Publisher handoff input', details: parsed.error.issues } });
    const asset = await assets.getPublishableAsset(projectId, parsed.data.assetId);
    if (!asset) return reply.code(422).send({ error: { code: 'PUBLISHER_ASSET_INVALID', message: 'A READY VIDEO_RENDER Asset owned by this project is required', details: [] } });
    if (parsed.data.coverAssetId) { const cover = await assets.getProjectAsset(projectId, parsed.data.coverAssetId); if (!cover || cover.lifecycle !== 'READY' || cover.kind !== 'VIDEO_RENDER') return reply.code(422).send({ error: { code: 'PUBLISHER_COVER_ASSET_INVALID', message: '封面 Asset 必须属于当前项目、处于 READY 且为支持的媒体类型', details: [] } }); }
    const accounts = await Promise.all(parsed.data.accountIds.map((accountId) => publisher.getAccount(projectId, accountId)));
    if (accounts.some((account) => !account)) return reply.code(422).send({ error: { code: 'PUBLISHER_ACCOUNT_INVALID', message: 'Every Publisher account must belong to this project', details: [] } });
    try {
      const items = [];
      for (const accountId of parsed.data.accountIds) {
        const created = await publisher.createRequest({
          projectId,
          accountId,
          idempotencyKey: `publisher:handoff:${parsed.data.idempotencyKey}:${accountId}`,
          correlationId: parsed.data.correlationId,
          revision: { assetId: asset.id, assetChecksum: asset.checksum, title: parsed.data.title, description: parsed.data.description, ...(parsed.data.hashtags ? { hashtags: parsed.data.hashtags } : {}), ...(parsed.data.coverAssetId ? { coverAssetId: parsed.data.coverAssetId } : {}), desiredPublishAt: parsed.data.desiredPublishAt, createdBy: parsed.data.createdBy },
        });
        // A handoff is the entry point to the Publish Approval Gate.  Keep the
        // gate tied to the immutable revision and do not overwrite an existing
        // decision when the handoff is repeated with the same idempotency key.
        const approval = await approvals.getCurrent(projectId, 'PUBLISH', created.request.id, created.revision.id);
        if (!approval) {
          await approvals.create({
            projectId,
            targetType: 'PUBLISH',
            targetId: created.request.id,
            targetRevisionId: created.revision.id,
            status: 'PENDING',
            approver: parsed.data.createdBy,
            evidence: { source: 'PUBLISHER_HANDOFF_V0', correlationId: parsed.data.correlationId },
          });
        }
        items.push(created);
      }
      await refreshProjectPublishingStatus(projectId, projects, publisher, assets);
      return reply.code(201).send({ projectId, assetId: asset.id, items });
    } catch (error) {
      return reply.code(409).send({ error: { code: 'PUBLISHER_HANDOFF_CONFLICT', message: error instanceof Error ? error.message : 'Publisher handoff conflict', details: [] } });
    }
  });

  app.get('/api/v1/projects/:projectId/publisher/requests/:requestId', async (request, reply) => {
    const projectId = projectIdOf(request);
    const requestId = requestIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const aggregate = await publisher.getRequestAggregate(projectId, requestId);
    if (!aggregate) return reply.code(404).send({ error: { code: 'PUBLISHER_REQUEST_NOT_FOUND', message: 'Publisher request not found', details: [] } });
    return safeAggregate(aggregate);
  });

  app.post('/api/v1/projects/:projectId/publisher/requests/:requestId/revisions', async (request, reply) => {
    const projectId = projectIdOf(request); const requestId = requestIdOf(request);
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const aggregate = await publisher.getRequestAggregate(projectId, requestId);
    if (!aggregate) return reply.code(404).send({ error: { code: 'PUBLISHER_REQUEST_NOT_FOUND', message: 'Publisher request not found', details: [] } });
    const parsed = revisionEditInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Publisher revision input', details: parsed.error.issues } });
    const asset = await assets.getPublishableAsset(projectId, parsed.data.assetId);
    if (!asset || asset.checksum !== parsed.data.assetChecksum) return reply.code(422).send({ error: { code: 'PUBLISHER_ASSET_INVALID', message: 'A READY render Asset matching the checksum is required', details: [] } });
    if (parsed.data.coverAssetId) {
      const cover = await assets.getProjectAsset(projectId, parsed.data.coverAssetId);
      if (!cover || cover.lifecycle !== 'READY' || cover.kind !== 'VIDEO_RENDER') return reply.code(422).send({ error: { code: 'PUBLISHER_COVER_ASSET_INVALID', message: '封面 Asset 必须属于当前项目、处于 READY 且为支持的媒体类型', details: [] } });
    }
    try {
      const revisionInput = { assetId: parsed.data.assetId, assetChecksum: parsed.data.assetChecksum, title: parsed.data.title, description: parsed.data.description, hashtags: parsed.data.hashtags || [], desiredPublishAt: parsed.data.desiredPublishAt, createdBy: parsed.data.createdBy } as { assetId: string; assetChecksum: string; title: string; description: string; hashtags: string[]; desiredPublishAt: string | null; createdBy: string; coverAssetId?: string };
      if (parsed.data.coverAssetId) revisionInput.coverAssetId = parsed.data.coverAssetId;
      const revision = await publisher.addRevision(requestId, revisionInput);
      await approvals.create({ projectId, targetType: 'PUBLISH', targetId: requestId, targetRevisionId: revision.id, status: 'PENDING', approver: parsed.data.createdBy, evidence: { source: 'PUBLISHER_REVISION_EDIT_V0' } });
      return reply.code(201).send(revision);
    } catch (error) { return reply.code(409).send({ error: { code: 'PUBLISHER_REVISION_CONFLICT', message: error instanceof Error ? error.message : 'Publisher revision conflict', details: [] } }); }
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
    const scheduled = aggregate.request.desiredPublishAt && new Date(aggregate.request.desiredPublishAt).getTime() > Date.now();
    if (aggregate.request.status !== (scheduled ? 'SCHEDULED' : 'QUEUED')) await publisher.transitionRequest(requestId, scheduled ? 'SCHEDULED' : 'QUEUED');
    await refreshProjectPublishingStatus(projectId, projects, publisher, assets);
    return reply.code(202).send({ jobId: job.id, requestId, state: job.state });
  });
}
