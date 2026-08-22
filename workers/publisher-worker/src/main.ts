import { JobRunner, type JobService, type JobRecord } from '../../../packages/modules/job/src/index.js';
import { PublisherService, FakePublisherService, type PublisherPublishJobPayload } from '../../../packages/modules/publisher/src/index.js';
import { ProjectService } from '../../../packages/modules/project/src/index.js';
import { AssetCatalogService } from '../../../packages/modules/asset/src/index.js';
import type { PublishResult, PublisherFailureClassification } from '../../../packages/contracts/src/index.js';
import { WorkerRuntime, type JobHandler } from '../../../packages/shared/src/worker-runtime.js';

export const PUBLISH_RECONCILE_JOB_TYPE = 'PUBLISH_RECONCILE';

export interface PublisherWorkerOptions {
  service: PublisherService;
  jobs: JobService;
  projects: ProjectService;
  assets: AssetCatalogService;
  fakePublisher: FakePublisherService;
  workerId?: string;
}

class PublisherHandlerError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable: boolean) { super(message); }
}

function payloadFromJob(job: JobRecord): PublisherPublishJobPayload {
  const value = job.payload as Partial<PublisherPublishJobPayload>;
  if (!value || typeof value !== 'object' || !value.projectId || !value.requestId || !value.revisionId || !value.accountId || !value.platformId || value.jobId !== job.id) throw new PublisherHandlerError('INVALID_PUBLISH_PAYLOAD', 'Publisher Job payload is invalid', false);
  return {
    projectId: value.projectId,
    requestId: value.requestId,
    revisionId: value.revisionId,
    accountId: value.accountId,
    platformId: value.platformId,
    jobId: value.jobId,
    jobAttemptId: value.jobAttemptId || null,
    correlationId: value.correlationId || 'publisher-worker',
  };
}

function isRetryable(classification: PublisherFailureClassification | undefined): boolean { return classification === 'RETRYABLE'; }

async function syncProjectPublishingStatus(service: PublisherService, projects: ProjectService, assets: AssetCatalogService, projectId: string): Promise<void> {
  const [summary, publishableAssets] = await Promise.all([service.getProjectSummary(projectId), assets.listPublishable(projectId)]);
  await projects.syncPublishingStatus(projectId, { hasPublishableAsset: publishableAssets.length > 0, publishedRequestCount: summary.statusCounts.PUBLISHED });
}

async function ensureReconcileJob(service: PublisherService, jobs: JobService, payload: PublisherPublishJobPayload): Promise<JobRecord> {
  const idempotencyKey = `publisher:reconcile:${payload.requestId}:${payload.revisionId}`;
  const reconcileJobId = `job-publish-reconcile-${payload.requestId}-${payload.revisionId}`;
  const reconcilePayload = await service.buildPublishJobPayload(payload.projectId, payload.requestId, reconcileJobId, null);
  return jobs.createIdempotent({ id: reconcileJobId, type: PUBLISH_RECONCILE_JOB_TYPE, projectId: payload.projectId, payload: reconcilePayload, idempotencyKey, maxAttempts: 3 });
}

async function executePublish(service: PublisherService, jobs: JobService, projects: ProjectService, assets: AssetCatalogService, fakePublisher: FakePublisherService, job: JobRecord, jobAttemptId: string): Promise<unknown> {
  const payload = payloadFromJob(job);
  const aggregate = await service.getRequestAggregate(payload.projectId, payload.requestId);
  if (!aggregate || aggregate.revision.id !== payload.revisionId) throw new PublisherHandlerError('PUBLISH_REQUEST_NOT_FOUND', 'Publisher request revision is not available', false);
  if (aggregate.request.status === 'PUBLISHED') {
    await syncProjectPublishingStatus(service, projects, assets, payload.projectId);
    return { status: 'PUBLISHED', requestId: payload.requestId };
  }
  const account = await service.getAccount(payload.projectId, payload.accountId);
  if (!account || account.platformId !== payload.platformId) throw new PublisherHandlerError('PUBLISH_ACCOUNT_NOT_FOUND', 'Publisher account is not available', false);
  if (aggregate.request.status === 'RECONCILING') {
    const reconcileJob = await ensureReconcileJob(service, jobs, payload);
    await syncProjectPublishingStatus(service, projects, assets, payload.projectId);
    return { status: 'RECONCILING', requestId: payload.requestId, reconcileJobId: reconcileJob.id };
  }
  if (account.status !== 'READY') throw new PublisherHandlerError('PUBLISH_ACCOUNT_NOT_READY', `Publisher account is ${account.status}`, false);
  const asset = await assets.getPublishableAsset(payload.projectId, aggregate.revision.assetId);
  if (!asset || asset.checksum !== aggregate.revision.assetChecksum) throw new PublisherHandlerError('PUBLISH_ASSET_NOT_READY', 'Publisher Asset is not a current READY render for this project', false);

  if (aggregate.request.status === 'FAILED') await service.transitionRequest(payload.requestId, 'QUEUED');
  const current = await service.getRequest(payload.requestId);
  if (current?.status === 'QUEUED') await service.transitionRequest(payload.requestId, 'PUBLISHING');
  else if (current?.status !== 'PUBLISHING') throw new PublisherHandlerError('PUBLISH_REQUEST_NOT_QUEUEABLE', `Publisher request is ${current?.status || 'missing'}`, false);

  const attempt = await service.startAttempt({ requestId: payload.requestId, revisionId: payload.revisionId, operation: 'PUBLISH', jobId: job.id, jobAttemptId });
  const snapshot = { requestId: payload.requestId, idempotencyKey: aggregate.request.idempotencyKey, assetId: aggregate.revision.assetId, title: aggregate.revision.title, description: aggregate.revision.description };
  let result: PublishResult;
  try { result = await fakePublisher.publish(account.id, snapshot); }
  catch (error) {
    await service.finishAttempt(attempt.id, { status: 'FAILED', failureCode: 'UNKNOWN', failureClassification: 'RETRYABLE', diagnostics: { code: 'HANDLER_EXCEPTION' } });
    await service.transitionRequest(payload.requestId, 'FAILED', { code: 'UNKNOWN', message: 'Publisher adapter failed before returning a normalized result' });
    throw new PublisherHandlerError('PUBLISH_ADAPTER_ERROR', error instanceof Error ? error.message : 'Publisher adapter failed', true);
  }

  if (result.status === 'PUBLISHED' && result.externalPostId) {
    await service.finishAttempt(attempt.id, { status: 'SUCCEEDED', diagnostics: { outcome: 'PUBLISHED' } });
    await service.recordExternalPost({ requestId: payload.requestId, accountId: account.id, platformId: account.platformId, externalPostId: result.externalPostId, externalUrl: null });
    await service.transitionRequest(payload.requestId, 'PUBLISHED');
    await syncProjectPublishingStatus(service, projects, assets, payload.projectId);
    return { status: 'PUBLISHED', requestId: payload.requestId, externalPostId: result.externalPostId };
  }

  const failure = result.failure;
  if (result.status === 'UNKNOWN_EXTERNAL_STATE') {
    await service.finishAttempt(attempt.id, { status: 'UNKNOWN', failureCode: failure?.code || 'UNKNOWN_EXTERNAL_STATE', failureClassification: failure?.classification || 'RECONCILIATION_REQUIRED', diagnostics: { outcome: 'UNKNOWN_EXTERNAL_STATE' } });
    await service.transitionRequest(payload.requestId, 'RECONCILING', { code: failure?.code || 'UNKNOWN_EXTERNAL_STATE', message: failure?.message || 'External state requires reconciliation' });
    const reconcileJob = await ensureReconcileJob(service, jobs, payload);
    await syncProjectPublishingStatus(service, projects, assets, payload.projectId);
    return { status: 'RECONCILING', requestId: payload.requestId, reconcileJobId: reconcileJob.id };
  }

  const code = failure?.code || 'UNKNOWN';
  const classification = failure?.classification || 'TERMINAL';
  await service.finishAttempt(attempt.id, { status: 'FAILED', failureCode: code, failureClassification: classification, diagnostics: { outcome: 'FAILED' } });
  await service.transitionRequest(payload.requestId, 'FAILED', { code, message: failure?.message || 'Publisher failed' });
  await syncProjectPublishingStatus(service, projects, assets, payload.projectId);
  throw new PublisherHandlerError(code, failure?.message || 'Publisher failed', isRetryable(classification));
}

async function executeReconcile(service: PublisherService, projects: ProjectService, assets: AssetCatalogService, fakePublisher: FakePublisherService, job: JobRecord, jobAttemptId: string): Promise<unknown> {
  const payload = payloadFromJob(job);
  const aggregate = await service.getRequestAggregate(payload.projectId, payload.requestId);
  if (!aggregate || aggregate.revision.id !== payload.revisionId) throw new PublisherHandlerError('RECONCILE_REQUEST_NOT_FOUND', 'Publisher request revision is not available', false);
  if (aggregate.request.status === 'PUBLISHED') {
    await syncProjectPublishingStatus(service, projects, assets, payload.projectId);
    return { status: 'PUBLISHED', requestId: payload.requestId };
  }
  const account = await service.getAccount(payload.projectId, payload.accountId);
  if (!account || account.platformId !== payload.platformId) throw new PublisherHandlerError('RECONCILE_ACCOUNT_NOT_FOUND', 'Publisher account is not available', false);
  if (aggregate.request.status !== 'RECONCILING') throw new PublisherHandlerError('RECONCILE_REQUEST_NOT_READY', `Publisher request is ${aggregate.request.status}`, false);

  const attempt = await service.startAttempt({ requestId: payload.requestId, revisionId: payload.revisionId, operation: 'RECONCILE', jobId: job.id, jobAttemptId });
  let result;
  try { result = await fakePublisher.reconcile(account.id, aggregate.request.idempotencyKey); }
  catch (error) {
    await service.finishAttempt(attempt.id, { status: 'FAILED', failureCode: 'UNKNOWN', failureClassification: 'RETRYABLE', diagnostics: { code: 'RECONCILE_HANDLER_EXCEPTION' } });
    throw new PublisherHandlerError('RECONCILE_ADAPTER_ERROR', error instanceof Error ? error.message : 'Publisher reconciliation failed', true);
  }

  if (result.status === 'PUBLISHED' && result.externalPostId) {
    await service.finishAttempt(attempt.id, { status: 'SUCCEEDED', diagnostics: { outcome: 'PUBLISHED' } });
    await service.recordExternalPost({ requestId: payload.requestId, accountId: account.id, platformId: account.platformId, externalPostId: result.externalPostId, externalUrl: null });
    await service.transitionRequest(payload.requestId, 'PUBLISHED');
    await syncProjectPublishingStatus(service, projects, assets, payload.projectId);
    return { status: 'PUBLISHED', requestId: payload.requestId, externalPostId: result.externalPostId };
  }
  if (result.status === 'NOT_FOUND') {
    await service.finishAttempt(attempt.id, { status: 'FAILED', failureCode: 'UNKNOWN_EXTERNAL_STATE', failureClassification: 'TERMINAL', diagnostics: { outcome: 'NOT_FOUND' } });
    await service.transitionRequest(payload.requestId, 'FAILED', { code: 'UNKNOWN_EXTERNAL_STATE', message: 'Reconciliation confirmed no external post was found' });
    await syncProjectPublishingStatus(service, projects, assets, payload.projectId);
    return { status: 'FAILED', requestId: payload.requestId };
  }
  await service.finishAttempt(attempt.id, { status: 'UNKNOWN', failureCode: 'UNKNOWN_EXTERNAL_STATE', failureClassification: 'RECONCILIATION_REQUIRED', diagnostics: { outcome: 'UNKNOWN' } });
  throw new PublisherHandlerError('RECONCILIATION_INCONCLUSIVE', 'External state remains unknown', true);
}

export function createPublisherWorker(options?: PublisherWorkerOptions | JobHandler): WorkerRuntime {
  if (!options) throw new Error('Publisher worker requires explicit Publisher worker dependencies');
  const runtime = new WorkerRuntime('publisher-worker');
  if (typeof options === 'function') {
    runtime.register('publisher.publish', options);
    return runtime;
  }
  const runner = new JobRunner(options.jobs, options.workerId || 'publisher-worker');
  runtime.register('PUBLISH', async (payload) => {
    const jobId = (payload as { jobId?: unknown })?.jobId;
    if (typeof jobId !== 'string' || !jobId) throw new PublisherHandlerError('INVALID_PUBLISH_JOB_REFERENCE', 'Publisher worker requires a Job id', false);
    return runner.run(jobId, (job, attemptId) => executePublish(options.service, options.jobs, options.projects, options.assets, options.fakePublisher, job, attemptId));
  });
  runtime.register(PUBLISH_RECONCILE_JOB_TYPE, async (payload) => {
    const jobId = (payload as { jobId?: unknown })?.jobId;
    if (typeof jobId !== 'string' || !jobId) throw new PublisherHandlerError('INVALID_RECONCILE_JOB_REFERENCE', 'Publisher reconciliation requires a Job id', false);
    return runner.run(jobId, (job, attemptId) => executeReconcile(options.service, options.projects, options.assets, options.fakePublisher, job, attemptId));
  });
  return runtime;
}

if (process.argv[1]?.endsWith('main.ts')) {
  throw new Error('Publisher worker composition must be provided by the deployment entrypoint');
}
