import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { FakePublisherAdapter, FakePublisherService, PublisherService } from '../../packages/modules/publisher/src/index.js';
import { createPublisherWorker } from '../../workers/publisher-worker/src/main.js';
import { createPublisherDevRunner } from '../../workers/publisher-worker/src/dev-main.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

async function fixture(db: Awaited<ReturnType<typeof createDatabase>>, outcome: ConstructorParameters<typeof FakePublisherAdapter>[0] = 'SUCCESS') {
  await migrateUp(db);
  const project = await new ProjectService(db).create(`Publisher Worker ${randomUUID()}`);
  const assetId = `asset-publisher-worker-${randomUUID()}`;
  const checksum = `sha256:${randomUUID()}`;
  await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO_RENDER', checksum, 100, `renders/${assetId}.mp4`, 'READY', { width: 1080, height: 1920 }]);
  const publisher = new PublisherService(db);
  const account = await publisher.createAccount({ projectId: project.id, platformId: 'fake-platform', displayName: `Fake ${randomUUID()}`, credentialRef: 'fake-credential:worker', profileKey: `profile-${randomUUID()}`, status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false } });
  const request = await publisher.createRequest({ projectId: project.id, accountId: account.id, idempotencyKey: `publisher-worker-${randomUUID()}`, correlationId: `correlation-${randomUUID()}`, revision: { assetId, assetChecksum: checksum, title: 'Worker 发布', description: '描述', desiredPublishAt: null, createdBy: 'test' } });
  await publisher.transitionRequest(request.request.id, 'QUEUED');
  const jobs = new JobService(db);
  const jobId = `job-publish-worker-${randomUUID()}`;
  const payload = await publisher.buildPublishJobPayload(project.id, request.request.id, jobId, null);
  const job = await jobs.create({ id: jobId, type: 'PUBLISH', projectId: project.id, payload, idempotencyKey: `job-publish-worker-${randomUUID()}`, maxAttempts: 3 });
  const root = await mkdtemp(join(tmpdir(), 'contentos-publisher-worker-product-'));
  return { projectId: project.id, requestId: request.request.id, job, jobs, publisher, fake: new FakePublisherService(root, new FakePublisherAdapter(outcome)), root };
}

async function cleanup(db: Awaited<ReturnType<typeof createDatabase>>, projectId: string, root: string): Promise<void> {
  await db.query('update publisher_requests set current_revision_id = null where project_id = $1', [projectId]);
  await db.query('delete from publisher_external_posts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_attempts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_request_revisions where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_requests where project_id = $1', [projectId]);
  await db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [projectId]);
  await db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [projectId]);
  await db.query('delete from jobs where project_id = $1', [projectId]);
  await db.query('delete from publisher_accounts where project_id = $1', [projectId]);
  await db.query('delete from assets where project_id = $1', [projectId]);
  await db.query('delete from content_projects where id = $1', [projectId]);
  await rm(root, { recursive: true, force: true });
}

test('Publisher Worker durably publishes and records external post', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  let root = '';
  try {
    const data = await fixture(db);
    projectId = data.projectId; root = data.root;
    const worker = createPublisherWorker({ service: data.publisher, jobs: data.jobs, fakePublisher: data.fake, workerId: 'publisher-worker-test' });
    await worker.start();
    assert.deepEqual(worker.handlerTypes(), ['PUBLISH']);
    const result = await worker.execute('PUBLISH', { jobId: data.job.id });
    assert.equal((result as { state: string }).state, 'SUCCEEDED');
    assert.equal((await data.publisher.getRequest(data.requestId))?.status, 'PUBLISHED');
    const posts = await db.query('select external_post_id from publisher_external_posts where request_id = $1', [data.requestId]);
    assert.equal(posts.rowCount, 1);
    await worker.shutdown('test');
  } finally { if (projectId) await cleanup(db, projectId, root); await db.end(); }
});

test('Publisher development runner polls queued PUBLISH Jobs', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  let root = '';
  let runner: ReturnType<typeof createPublisherDevRunner> | undefined;
  try {
    const data = await fixture(db);
    projectId = data.projectId; root = data.root;
    runner = createPublisherDevRunner({ service: data.publisher, jobs: data.jobs, fakePublisher: data.fake, workerId: 'publisher-worker-dev-test' }, { pollIntervalMs: 10_000, batchSize: 1 });
    await runner.start();
    const completed = await data.jobs.get(data.job.id);
    assert.equal(completed?.state, 'SUCCEEDED', JSON.stringify(completed));
  } finally { if (runner) await runner.stop('test'); if (projectId) await cleanup(db, projectId, root); await db.end(); }
});

test('Publisher Worker maps retryable and human-action failures safely', async () => {
  for (const [outcome, expectedState, expectedJobState] of [['RATE_LIMIT', 'FAILED', 'RETRY_WAIT'], ['AUTH_EXPIRED', 'FAILED', 'FAILED']] as const) {
    const db = await createDatabase(databaseUrl);
    let projectId = '';
    let root = '';
    try {
      const data = await fixture(db, outcome);
      projectId = data.projectId; root = data.root;
      const worker = createPublisherWorker({ service: data.publisher, jobs: data.jobs, fakePublisher: data.fake, workerId: `publisher-worker-${outcome}` });
      await worker.start();
      const result = await worker.execute('PUBLISH', { jobId: data.job.id }) as { state: string };
      assert.equal(result.state, expectedJobState);
      assert.equal((await data.publisher.getRequest(data.requestId))?.status, expectedState);
      await worker.shutdown('test');
    } finally { if (projectId) await cleanup(db, projectId, root); await db.end(); }
  }
});

test('Publisher Worker moves uncertain external state to reconciliation without blind retry', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  let root = '';
  try {
    const data = await fixture(db, 'BROWSER_CRASH');
    projectId = data.projectId; root = data.root;
    const worker = createPublisherWorker({ service: data.publisher, jobs: data.jobs, fakePublisher: data.fake, workerId: 'publisher-worker-unknown' });
    await worker.start();
    const result = await worker.execute('PUBLISH', { jobId: data.job.id }) as { state: string };
    assert.equal(result.state, 'SUCCEEDED');
    assert.equal((await data.publisher.getRequest(data.requestId))?.status, 'RECONCILING');
    const attempts = await data.publisher.listAttempts(data.requestId);
    assert.equal(attempts[0]?.status, 'UNKNOWN');
    await worker.shutdown('test');
  } finally { if (projectId) await cleanup(db, projectId, root); await db.end(); }
});
