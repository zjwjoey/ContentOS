import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { AssetCatalogService } from '../../packages/modules/asset/src/index.js';
import { JobService, type JobLeaseRecoveryHandler } from '../../packages/modules/job/src/index.js';
import { FakePublisherService, PublisherService } from '../../packages/modules/publisher/src/index.js';
import { createPublisherLeaseRecoveryHandler, createPublisherWorker } from '../../workers/publisher-worker/src/main.js';
import { directorLeaseRecoveryHandler } from '../../workers/director-worker/src/main.js';
import { benchmarkLeaseRecoveryHandler } from '../../workers/benchmark-worker/src/main.js';
import { reviewLeaseRecoveryHandler } from '../../workers/review-worker/src/main.js';

async function fixture(type = 'PUBLISH') {
  const url = process.env.CONTENTOS_TEST_DATABASE_URL;
  assert.ok(url, 'explicit isolated test database required');
  assert.equal(new URL(url).pathname, '/contentos_test');
  const admin = await createDatabase(url);
  const schema = `publisher_lease_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`);
  const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
  const db = new pg.Pool({ connectionString: scoped.toString(), max: 2, connectionTimeoutMillis: 2_000 });
  await migrateUp(db);
  const projects = new ProjectService(db);
  const project = await projects.create('Publisher crash policy');
  const assetId = `asset-${randomUUID()}`;
  await db.query("insert into assets(id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values($1,$2,'VIDEO_RENDER','fixture-checksum',1,'fixture.mp4','READY','{}')", [assetId, project.id]);
  const publisher = new PublisherService(db);
  const account = await publisher.createAccount({ projectId: project.id, platformId: 'fake-platform', displayName: 'Isolated fake', credentialRef: 'fixture-ref', profileKey: 'fixture-profile', status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false } });
  const request = await publisher.createRequest({ projectId: project.id, accountId: account.id, idempotencyKey: randomUUID(), correlationId: randomUUID(), revision: { assetId, assetChecksum: 'fixture-checksum', title: 'Fake only', description: '', desiredPublishAt: null, createdBy: 'test' } });
  await publisher.transitionRequest(request.request.id, 'QUEUED');
  const jobs = new JobService(db);
  const jobId = `job-${randomUUID()}`;
  const payload = await publisher.buildPublishJobPayload(project.id, request.request.id, jobId, null);
  await jobs.create({ id: jobId, type, projectId: project.id, idempotencyKey: jobId, maxAttempts: 3, payload });
  return { db, jobs, publisher, projects, project, account, request, jobId, close: async () => { await db.end(); await admin.query(`drop schema "${schema}" cascade`); await admin.end(); } };
}

async function loseLease(f: Awaited<ReturnType<typeof fixture>>, recover: JobLeaseRecoveryHandler | undefined, ownerAttempt = true) {
  const claimed = await f.jobs.claim(f.jobId, 'crashed-worker', 30_000);
  assert.ok(claimed);
  if (ownerAttempt) {
    const request = await f.publisher.getRequest(f.request.request.id);
    if (request?.status === 'QUEUED') await f.publisher.transitionRequest(request.id, 'PUBLISHING');
    await f.publisher.startAttempt({ requestId: f.request.request.id, revisionId: f.request.revision.id, operation: claimed.job.type === 'PUBLISH_RECONCILE' ? 'RECONCILE' : 'PUBLISH', jobId: f.jobId, jobAttemptId: claimed.attemptId });
  }
  await f.db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [f.jobId]);
  await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: [claimed.job.type], ...(recover ? { recover } : {}) });
  return claimed;
}

test('Publisher lease loss retains unknown external truth and ends bounded recovery with a human action', async () => {
  const f = await fixture('PUBLISH_RECONCILE');
  try {
    const recover = createPublisherLeaseRecoveryHandler(f.publisher);
    for (let count = 1; count <= 3; count += 1) {
      await loseLease(f, recover);
      const job = await f.jobs.get(f.jobId);
      assert.equal(job?.state, count < 3 ? 'RETRY_WAIT' : 'FAILED');
      assert.equal((await f.publisher.getRequest(f.request.request.id))?.status, 'RECONCILING');
      const owner = await f.publisher.getRequestAggregate(f.project.id, f.request.request.id);
      assert.equal(owner?.attempts.at(-1)?.status, 'UNKNOWN');
      assert.equal(owner?.attempts.at(-1)?.failureCode, 'UNKNOWN_EXTERNAL_STATE');
      assert.equal(owner?.attempts.some((attempt) => attempt.status === 'RUNNING'), false);
      assert.equal(owner?.externalPosts.length, 0);
      if (count < 3) await f.jobs.requeue(f.jobId);
    }
    assert.equal((await f.publisher.getRequestAggregate(f.project.id, f.request.request.id))?.nextAction, 'NEEDS_HUMAN_ACTION');
    assert.equal(await f.jobs.claim(f.jobId, 'fourth-worker', 30_000), null);
    assert.equal((await f.jobs.attempts(f.jobId)).length, 3);
  } finally { await f.close(); }
});

test('Publisher recovery refuses confirmed PUBLISHED output and preserves it through BLOCKED scans', async () => {
  const f = await fixture();
  try {
    await f.publisher.transitionRequest(f.request.request.id, 'PUBLISHING');
    await f.publisher.recordExternalPost({ requestId: f.request.request.id, accountId: f.account.id, platformId: 'fake-platform', externalPostId: 'already-confirmed', externalUrl: null });
    await f.publisher.transitionRequest(f.request.request.id, 'PUBLISHED');
    const before = await f.publisher.getRequest(f.request.request.id);
    const recover = createPublisherLeaseRecoveryHandler(f.publisher);
    await loseLease(f, recover, false);
    assert.equal((await f.jobs.get(f.jobId))?.state, 'BLOCKED');
    assert.equal((await f.jobs.get(f.jobId))?.attemptCount, 1);
    assert.equal(await f.jobs.claim(f.jobId, 'unsafe-replay', 30_000), null);
    await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['PUBLISH'], recover });
    assert.deepEqual(await f.publisher.getRequest(f.request.request.id), before);
    assert.equal((await f.publisher.listExternalPosts(f.request.request.id))[0]?.externalPostId, 'already-confirmed');
  } finally { await f.close(); }
});

test('Publisher exhausted legacy BLOCKED recovery closes abandoned attempts when its missing callback becomes available', async () => {
  const f = await fixture();
  try {
    for (let count = 1; count <= 3; count += 1) { await loseLease(f, undefined); if (count < 3) await f.jobs.requeue(f.jobId); }
    assert.equal((await f.jobs.get(f.jobId))?.state, 'BLOCKED');
    assert.equal((await f.publisher.listAttempts(f.request.request.id)).filter((attempt) => attempt.status === 'RUNNING').length, 3);
    const recover = createPublisherLeaseRecoveryHandler(f.publisher);
    assert.equal(await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['PUBLISH'], recover }), 1);
    assert.equal((await f.jobs.get(f.jobId))?.state, 'FAILED');
    const owner = await f.publisher.getRequestAggregate(f.project.id, f.request.request.id);
    assert.equal(owner?.request.status, 'RECONCILING');
    assert.equal(owner?.nextAction, 'NEEDS_HUMAN_ACTION');
    assert.equal(owner?.attempts.some((attempt) => attempt.status === 'RUNNING'), false);
    assert.equal(owner?.externalPosts.length, 0);
    assert.equal(await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['PUBLISH'], recover }), 0);
    assert.equal((await f.db.query("select id from job_events where job_id=$1 and event_type='job.lease_retry_exhausted'", [f.jobId])).rowCount, 1);
  } finally { await f.close(); }
});

test('Publisher refusing owner pauses the first loss and resumes below the crash limit after authoritative repair', async () => {
  const f = await fixture();
  try {
    await loseLease(f, async () => false);
    assert.equal((await f.jobs.get(f.jobId))?.state, 'BLOCKED');
    assert.equal((await f.jobs.get(f.jobId))?.attemptCount, 1);
    assert.equal(await f.jobs.claim(f.jobId, 'unsafe-replay', 30_000), null);
    const recover = createPublisherLeaseRecoveryHandler(f.publisher);
    assert.equal(await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['PUBLISH'], recover }), 1);
    assert.equal((await f.jobs.get(f.jobId))?.state, 'RETRY_WAIT');
    assert.equal((await f.jobs.get(f.jobId))?.attemptCount, 1);
    const owner = await f.publisher.getRequestAggregate(f.project.id, f.request.request.id);
    assert.equal(owner?.request.status, 'RECONCILING');
    assert.equal(owner?.attempts[0]?.status, 'UNKNOWN');
    assert.equal(owner?.attempts[0]?.failureClassification, 'RECONCILIATION_REQUIRED');
    assert.equal(owner?.nextAction, null);
    assert.equal((await f.db.query('select consecutive_lease_failures from jobs where id=$1', [f.jobId])).rows[0].consecutive_lease_failures, 1);
    assert.equal((await f.db.query("select id from job_events where job_id=$1 and event_type='job.lease_retry_exhausted'", [f.jobId])).rowCount, 0);
  } finally { await f.close(); }
});

test('Publisher repairs a confirmed post before request completion without publishing it again', async () => {
  const f = await fixture();
  let publishCalls = 0;
  const fake = new FakePublisherService('unused-fixture-profile');
  fake.publish = async () => { publishCalls += 1; throw new Error('confirmed post must never be published again'); };
  const worker = createPublisherWorker({ service: f.publisher, jobs: f.jobs, projects: f.projects, assets: new AssetCatalogService(f.db), fakePublisher: fake });
  try {
    await f.publisher.transitionRequest(f.request.request.id, 'PUBLISHING');
    await f.publisher.recordExternalPost({ requestId: f.request.request.id, accountId: f.account.id, platformId: 'fake-platform', externalPostId: 'confirmed-before-local-finish', externalUrl: null });
    await worker.start();
    const result = await worker.execute('PUBLISH', { jobId: f.jobId }) as { state: string };
    assert.equal(result.state, 'SUCCEEDED');
    assert.equal((await f.publisher.getRequest(f.request.request.id))?.status, 'PUBLISHED');
    assert.equal((await f.publisher.listExternalPosts(f.request.request.id)).length, 1);
    assert.equal(publishCalls, 0);
  } finally { await worker.shutdown('test'); await f.close(); }
});

test('Publisher provider failure messages are redacted in the new fenced owner persistence path', async () => {
  const f = await fixture();
  const fake = new FakePublisherService('unused-fixture-profile');
  fake.publish = async () => ({ status: 'FAILED', failure: { code: 'AUTH_EXPIRED', classification: 'HUMAN_ACTION_REQUIRED', message: 'https://user:fixture-url-secret@provider.invalid auth rejected password=fixture-password Bearer fixture-bearer' } });
  const worker = createPublisherWorker({ service: f.publisher, jobs: f.jobs, projects: f.projects, assets: new AssetCatalogService(f.db), fakePublisher: fake });
  try {
    await worker.start(); assert.equal((await worker.execute('PUBLISH', { jobId: f.jobId }) as { state: string }).state, 'FAILED');
    const owner = await f.publisher.getRequestAggregate(f.project.id, f.request.request.id);
    assert.equal(owner?.request.failureCode, 'AUTH_EXPIRED'); assert.match(owner?.request.failureMessage || '', /auth rejected/); assert.match(owner?.request.failureMessage || '', /REDACTED/);
    assert.doesNotMatch(JSON.stringify(owner), /fixture-url-secret|fixture-password|fixture-bearer/);
    assert.doesNotMatch(JSON.stringify((await f.db.query('select error from jobs where id=$1', [f.jobId])).rows[0]), /fixture-url-secret|fixture-password|fixture-bearer/);
  } finally { await worker.shutdown('test'); await f.close(); }
});

test('Publisher reconciliation repairs confirmed external truth without consulting an adapter that reports NOT_FOUND', async () => {
  const f = await fixture('PUBLISH_RECONCILE');
  let reconcileCalls = 0;
  const fake = new FakePublisherService('unused-fixture-profile');
  fake.reconcile = async () => { reconcileCalls += 1; return { status: 'NOT_FOUND' }; };
  const worker = createPublisherWorker({ service: f.publisher, jobs: f.jobs, projects: f.projects, assets: new AssetCatalogService(f.db), fakePublisher: fake });
  try {
    await f.publisher.transitionRequest(f.request.request.id, 'PUBLISHING');
    await f.publisher.transitionRequest(f.request.request.id, 'RECONCILING');
    const firstPublishedAt = '2026-10-01T01:02:03.123Z';
    await f.db.query('update publisher_requests set published_at=$2 where id=$1', [f.request.request.id, firstPublishedAt]);
    const firstMappedPublishedAt = (await f.publisher.getRequest(f.request.request.id))?.publishedAt;
    const confirmed = await f.publisher.recordExternalPost({ requestId: f.request.request.id, accountId: f.account.id, platformId: 'fake-platform', externalPostId: 'confirmed-before-reconcile', externalUrl: null });
    const expired = await f.jobs.claim(f.jobId, 'crashed-reconcile', 30_000); assert.ok(expired);
    await f.db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [f.jobId]);
    // The missing-callback legacy path permits this bounded replay; a registered
    // refusing owner is separately verified to BLOCK on its first lease loss.
    await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['PUBLISH_RECONCILE'] });
    assert.equal((await f.jobs.get(f.jobId))?.state, 'RETRY_WAIT');
    await worker.start();
    const result = await worker.execute('PUBLISH_RECONCILE', { jobId: f.jobId }) as { state: string };
    assert.equal(result.state, 'SUCCEEDED');
    assert.equal((await f.publisher.getRequest(f.request.request.id))?.status, 'PUBLISHED');
    assert.equal((await f.publisher.getRequest(f.request.request.id))?.publishedAt, firstMappedPublishedAt);
    const timestamp = await f.db.query<{ published_at: Date }>('select published_at from publisher_requests where id=$1', [f.request.request.id]);
    assert.equal(timestamp.rows[0]!.published_at.toISOString(), firstPublishedAt);
    assert.deepEqual(await f.publisher.listExternalPosts(f.request.request.id), [confirmed]);
    assert.equal((await f.publisher.listAttempts(f.request.request.id)).length, 0);
    assert.equal(reconcileCalls, 0);
    const published = await f.publisher.getRequest(f.request.request.id);
    await f.jobs.requeueTerminal(f.jobId); // Successful Jobs remain terminal; duplicate delivery preserves their first completion.
    await worker.execute('PUBLISH_RECONCILE', { jobId: f.jobId });
    assert.deepEqual(await f.publisher.getRequest(f.request.request.id), published);
    assert.deepEqual(await f.publisher.listExternalPosts(f.request.request.id), [confirmed]);
    assert.equal(reconcileCalls, 0);
  } finally { await worker.shutdown('test'); await f.close(); }
});

for (const lateOutcome of ['result', 'exception'] as const) {
test(`late Publisher adapter ${lateOutcome} cannot overwrite lease recovery or catalog an external post`, async () => {
  const f = await fixture();
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
  const fake = new FakePublisherService('unused-fixture-profile');
  fake.publish = async () => { entered(); await gate; if (lateOutcome === 'exception') throw new Error('late provider error'); return { status: 'PUBLISHED', externalPostId: 'late-stale-post' }; };
  const worker = createPublisherWorker({ service: f.publisher, jobs: f.jobs, projects: f.projects, assets: new AssetCatalogService(f.db), fakePublisher: fake });
  let running: Promise<unknown> | undefined;
  try {
    await worker.start();
    running = worker.execute('PUBLISH', { jobId: f.jobId });
    await providerEntered;
    await f.db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [f.jobId]);
    await f.jobs.reconcileExpiredLeases(new Date(), undefined, { types: ['PUBLISH'], recover: createPublisherLeaseRecoveryHandler(f.publisher) });
    const recovered = await f.publisher.getRequestAggregate(f.project.id, f.request.request.id);
    release(); await running;
    const after = await f.publisher.getRequestAggregate(f.project.id, f.request.request.id);
    assert.deepEqual(after, recovered);
    assert.equal(after?.request.status, 'RECONCILING');
    assert.equal(after?.externalPosts.length, 0);
    assert.equal((await f.jobs.get(f.jobId))?.state, 'RETRY_WAIT');
  } finally { release(); if (running) await running; await worker.shutdown('test'); await f.close(); }
});

}

for (const [type, recover] of [['DIRECTOR_GENERATE_SCRIPT', directorLeaseRecoveryHandler], ['BENCHMARK_ANALYZE', benchmarkLeaseRecoveryHandler], ['REVIEW_GENERATE_ANALYSIS', reviewLeaseRecoveryHandler]] as const) {
  test(`${type} stateless owner closes the third crashed attempt without an automatic fourth execution`, async () => {
    const f = await fixture(type);
    try {
      for (let count = 1; count <= 3; count += 1) { await loseLease(f, recover, false); if (count < 3) await f.jobs.requeue(f.jobId); }
      assert.equal((await f.jobs.get(f.jobId))?.state, 'FAILED');
      assert.equal(await f.jobs.claim(f.jobId, 'fourth-worker', 30_000), null);
      assert.equal((await f.jobs.attempts(f.jobId)).length, 3);
    } finally { await f.close(); }
  });
}
