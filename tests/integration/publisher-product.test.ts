import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { PublisherService } from '../../packages/modules/publisher/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

async function fixture(db: Awaited<ReturnType<typeof createDatabase>>) {
  await migrateUp(db);
  const project = await new ProjectService(db).create(`Publisher Product ${randomUUID()}`);
  const assetId = `asset-publisher-product-${randomUUID()}`;
  const checksum = `sha256:${randomUUID()}`;
  await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO_RENDER', checksum, 100, `renders/${assetId}.mp4`, 'READY', { width: 1080, height: 1920 }]);
  const publisher = new PublisherService(db);
  const account = await publisher.createAccount({ projectId: project.id, platformId: 'fake-platform', displayName: `Fake ${randomUUID()}`, credentialRef: 'fake-credential:account', profileKey: `profile-${randomUUID()}`, status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false } });
  const request = await publisher.createRequest({ projectId: project.id, accountId: account.id, idempotencyKey: `publisher-product-${randomUUID()}`, correlationId: `correlation-${randomUUID()}`, revision: { assetId, assetChecksum: checksum, title: '测试发布', description: '描述', desiredPublishAt: null, createdBy: 'test' } });
  return { projectId: project.id, assetId, accountId: account.id, request, publisher };
}

async function cleanup(db: Awaited<ReturnType<typeof createDatabase>>, projectId: string): Promise<void> {
  await db.query('update publisher_requests set current_revision_id = null where project_id = $1', [projectId]);
  await db.query('delete from publisher_external_posts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_attempts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_request_revisions where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_requests where project_id = $1', [projectId]);
  await db.query('delete from publisher_accounts where project_id = $1', [projectId]);
  await db.query('delete from assets where project_id = $1', [projectId]);
  await db.query('delete from content_projects where id = $1', [projectId]);
}

test('Publisher product queries stay project scoped and build a secret-free publish payload', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  try {
    const data = await fixture(db);
    projectId = data.projectId;
    assert.equal((await data.publisher.listAccounts(projectId)).length, 1);
    assert.equal((await data.publisher.listRequests(projectId)).length, 1);
    const aggregate = await data.publisher.getRequestAggregate(projectId, data.request.request.id);
    assert.equal(aggregate?.revision.id, data.request.revision.id);
    const payload = await data.publisher.buildPublishJobPayload(projectId, data.request.request.id, 'job-publish-1', 'job-attempt-1');
    assert.deepEqual(payload, {
      projectId,
      requestId: data.request.request.id,
      revisionId: data.request.revision.id,
      accountId: data.accountId,
      platformId: 'fake-platform',
      jobId: 'job-publish-1',
      jobAttemptId: 'job-attempt-1',
      correlationId: data.request.request.correlationId,
    });
    assert.equal(JSON.stringify(payload).includes('credential'), false);
    assert.equal(JSON.stringify(payload).includes('profile'), false);
  } finally {
    if (projectId) await cleanup(db, projectId);
    await db.end();
  }
});

test('Publisher product aggregate rejects a request from another project', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  try {
    const data = await fixture(db);
    projectId = data.projectId;
    assert.equal(await data.publisher.getRequestAggregate('project-does-not-match', data.request.request.id), null);
  } finally {
    if (projectId) await cleanup(db, projectId);
    await db.end();
  }
});

test('Publisher aggregate exposes a stable human-action state after auth failure', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  try {
    const data = await fixture(db);
    projectId = data.projectId;
    const attempt = await data.publisher.startAttempt({ requestId: data.request.request.id, revisionId: data.request.revision.id, operation: 'PUBLISH', jobId: null, jobAttemptId: null });
    await data.publisher.finishAttempt(attempt.id, { status: 'FAILED', failureCode: 'AUTH_EXPIRED', failureClassification: 'HUMAN_ACTION_REQUIRED', diagnostics: { outcome: 'AUTH_EXPIRED' } });
    const aggregate = await data.publisher.getRequestAggregate(projectId, data.request.request.id);
    assert.equal(aggregate?.nextAction, 'NEEDS_HUMAN_ACTION');
    assert.equal(aggregate?.attempts.at(-1)?.failureCode, 'AUTH_EXPIRED');
  } finally {
    if (projectId) await cleanup(db, projectId);
    await db.end();
  }
});

test('Publisher idempotency rejects a reused key with different request input', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  try {
    const data = await fixture(db);
    projectId = data.projectId;
    await assert.rejects(
      () => data.publisher.createRequest({
        projectId,
        accountId: data.accountId,
        idempotencyKey: data.request.request.idempotencyKey,
        correlationId: data.request.request.correlationId,
        revision: { ...data.request.revision, description: '不同输入' },
      }),
      /Idempotency key conflict/,
    );
  } finally {
    if (projectId) await cleanup(db, projectId);
    await db.end();
  }
});

test('Publisher exposes a project summary without leaking private attempt diagnostics', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  try {
    const data = await fixture(db);
    projectId = data.projectId;
    const summary = await data.publisher.getProjectSummary(projectId);
    assert.deepEqual(summary, {
      projectId,
      accountCount: 1,
      requestCount: 1,
      statusCounts: { DRAFT: 1, SCHEDULED: 0, QUEUED: 0, PUBLISHING: 0, RECONCILING: 0, PUBLISHED: 0, FAILED: 0, CANCELLED: 0 },
      confirmedExternalPostCount: 0,
      needsHumanActionCount: 0,
    });
    assert.equal(JSON.stringify(summary).includes('diagnostics'), false);
  } finally {
    if (projectId) await cleanup(db, projectId);
    await db.end();
  }
});

test('Publisher summary only counts the latest unresolved human-action attempt', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  try {
    const data = await fixture(db);
    projectId = data.projectId;
    const first = await data.publisher.startAttempt({ requestId: data.request.request.id, revisionId: data.request.revision.id, operation: 'PUBLISH', jobId: null, jobAttemptId: null });
    await data.publisher.finishAttempt(first.id, { status: 'FAILED', failureCode: 'AUTH_EXPIRED', failureClassification: 'HUMAN_ACTION_REQUIRED' });
    const second = await data.publisher.startAttempt({ requestId: data.request.request.id, revisionId: data.request.revision.id, operation: 'PUBLISH', jobId: null, jobAttemptId: null });
    await data.publisher.finishAttempt(second.id, { status: 'FAILED', failureCode: 'NETWORK_ERROR', failureClassification: 'RETRYABLE' });
    assert.equal((await data.publisher.getProjectSummary(projectId)).needsHumanActionCount, 0);
  } finally {
    if (projectId) await cleanup(db, projectId);
    await db.end();
  }
});

test('Project lifecycle moves to READY_TO_PUBLISH and PUBLISHED from explicit publishing facts', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  try {
    const project = await new ProjectService(db).create(`Project lifecycle ${randomUUID()}`);
    projectId = project.id;
    const projects = new ProjectService(db);
    const ready = await projects.syncPublishingStatus(projectId, { hasPublishableAsset: true, publishedRequestCount: 0 });
    assert.equal(ready.status, 'READY_TO_PUBLISH');
    const published = await projects.syncPublishingStatus(projectId, { hasPublishableAsset: true, publishedRequestCount: 1 });
    assert.equal(published.status, 'PUBLISHED');
  } finally {
    if (projectId) await db.query('delete from content_projects where id = $1', [projectId]);
    await db.end();
  }
});

test('Project publishing lifecycle remains monotonic under concurrent status syncs', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  try {
    const project = await new ProjectService(db).create(`Project lifecycle race ${randomUUID()}`);
    projectId = project.id;
    const first = new ProjectService(db);
    const second = new ProjectService(db);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await db.query('update content_projects set status = $2 where id = $1', [projectId, 'DRAFT']);
      await Promise.all([
        first.syncPublishingStatus(projectId, { hasPublishableAsset: true, publishedRequestCount: 1 }),
        second.syncPublishingStatus(projectId, { hasPublishableAsset: true, publishedRequestCount: 0 }),
      ]);
      assert.equal((await new ProjectService(db).get(projectId))?.status, 'PUBLISHED');
    }
  } finally {
    if (projectId) await db.query('delete from content_projects where id = $1', [projectId]);
    await db.end();
  }
});
