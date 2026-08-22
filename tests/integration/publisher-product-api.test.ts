import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { PublisherService } from '../../packages/modules/publisher/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

async function fixture(db: Awaited<ReturnType<typeof createDatabase>>) {
  await migrateUp(db);
  const project = await new ProjectService(db).create(`Publisher API ${randomUUID()}`);
  const assetId = `asset-publisher-api-${randomUUID()}`;
  const checksum = `sha256:${randomUUID()}`;
  await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO_RENDER', checksum, 100, `renders/${assetId}.mp4`, 'READY', { width: 1080, height: 1920 }]);
  const publisher = new PublisherService(db);
  const account = await publisher.createAccount({ projectId: project.id, platformId: 'fake-platform', displayName: `Fake ${randomUUID()}`, credentialRef: 'fake-credential:api', profileKey: `profile-${randomUUID()}`, status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false } });
  return { projectId: project.id, assetId, checksum, accountId: account.id };
}

async function cleanup(db: Awaited<ReturnType<typeof createDatabase>>, projectId: string): Promise<void> {
  await db.query('update publisher_requests set current_revision_id = null where project_id = $1', [projectId]);
  await db.query('delete from publisher_external_posts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_attempts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_request_revisions where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_requests where project_id = $1', [projectId]);
  await db.query('delete from jobs where project_id = $1', [projectId]);
  await db.query('delete from review_decisions where project_id = $1', [projectId]);
  await db.query('delete from publisher_accounts where project_id = $1', [projectId]);
  await db.query('delete from assets where project_id = $1', [projectId]);
  await db.query('delete from content_projects where id = $1', [projectId]);
}

test('Publisher API creates project-scoped account and request', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  const app = await buildApi(db);
  try {
    const data = await fixture(db);
    projectId = data.projectId;
    const accountResponse = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/publisher/accounts`, payload: { platformId: 'fake-platform', displayName: `Operator Fake ${randomUUID()}`, credentialRef: 'fake-credential:operator', profileKey: `operator-${randomUUID()}`, status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false } } });
    assert.equal(accountResponse.statusCode, 201);
    const requestResponse = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/publisher/requests`, payload: { accountId: data.accountId, idempotencyKey: `publisher-api-${randomUUID()}`, correlationId: `correlation-${randomUUID()}`, revision: { assetId: data.assetId, assetChecksum: data.checksum, title: 'API 发布', description: '描述', desiredPublishAt: null, createdBy: 'operator' } } });
    assert.equal(requestResponse.statusCode, 201);
    const request = requestResponse.json() as { request: { id: string; projectId: string; status: string }; revision: { title: string } };
    assert.equal(request.request.projectId, projectId);
    assert.equal(request.request.status, 'DRAFT');
    assert.equal(request.revision.title, 'API 发布');
    const listResponse = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/publisher/requests` });
    assert.equal(listResponse.statusCode, 200);
    assert.equal((listResponse.json() as { items: unknown[] }).items.length, 1);
  } finally {
    await app.close();
    if (projectId) await cleanup(db, projectId);
    await db.end();
  }
});

test('Publisher queue endpoint requires approved Publish review and is idempotent', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  const app = await buildApi(db);
  try {
    const data = await fixture(db);
    projectId = data.projectId;
    const createRequest = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/publisher/requests`, payload: { accountId: data.accountId, idempotencyKey: `publisher-queue-${randomUUID()}`, correlationId: `correlation-${randomUUID()}`, revision: { assetId: data.assetId, assetChecksum: data.checksum, title: '待审核发布', description: '', desiredPublishAt: null, createdBy: 'operator' } } });
    const requestId = (createRequest.json() as { request: { id: string } }).request.id;
    const blocked = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/publisher/requests/${requestId}/queue` });
    assert.equal(blocked.statusCode, 409);
    assert.equal((blocked.json() as { error: { code: string } }).error.code, 'PUBLISH_REVIEW_REQUIRED');
    const pending = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/reviews`, payload: { targetType: 'PUBLISH', targetId: requestId, status: 'PENDING', reviewer: 'operator' } });
    assert.equal(pending.statusCode, 201);
    const approved = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/reviews/PUBLISH/${requestId}/approve`, payload: { reviewer: 'operator' } });
    assert.equal(approved.statusCode, 200);
    const queued = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/publisher/requests/${requestId}/queue` });
    assert.equal(queued.statusCode, 202);
    const job = queued.json() as { jobId: string; requestId: string; state: string };
    assert.equal(job.requestId, requestId);
    assert.equal(job.state, 'QUEUED');
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/publisher/requests/${requestId}/queue` });
    assert.equal(duplicate.statusCode, 202);
    assert.equal((duplicate.json() as { jobId: string }).jobId, job.jobId);
  } finally {
    await app.close();
    if (projectId) await cleanup(db, projectId);
    await db.end();
  }
});
