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
  await db.query('delete from approval_decisions where project_id = $1', [projectId]);
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
    const accountResponse = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/publisher/accounts`, payload: { platformId: 'fake-platform', displayName: `Operator Fake ${randomUUID()}`, status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false } } });
    assert.equal(accountResponse.statusCode, 201, accountResponse.body);
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

test('Publisher queue endpoint requires an approved Publish Approval and is idempotent', async () => {
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
    assert.equal((blocked.json() as { error: { code: string } }).error.code, 'PUBLISH_APPROVAL_REQUIRED');
    const revisionId = (createRequest.json() as { revision: { id: string } }).revision.id;
    const pending = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/approvals`, payload: { targetType: 'PUBLISH', targetId: requestId, targetRevisionId: revisionId, status: 'PENDING', approver: 'operator' } });
    assert.equal(pending.statusCode, 201);
    const approved = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/approvals/PUBLISH/${requestId}/${revisionId}/approve`, payload: { approver: 'operator' } });
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

test('Publisher asset picker is project scoped and rejects foreign or mismatched assets', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  let foreignProjectId = '';
  const app = await buildApi(db);
  try {
    const data = await fixture(db);
    projectId = data.projectId;
    const foreignProject = await new ProjectService(db).create(`Publisher Foreign ${randomUUID()}`);
    foreignProjectId = foreignProject.id;
    const foreignAssetId = `asset-publisher-foreign-${randomUUID()}`;
    const foreignChecksum = `sha256:${randomUUID()}`;
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [foreignAssetId, foreignProjectId, 'VIDEO_RENDER', foreignChecksum, 100, `renders/${foreignAssetId}.mp4`, 'READY', { width: 1080, height: 1920 }]);
    const assets = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/publisher/assets` });
    assert.equal(assets.statusCode, 200);
    assert.deepEqual((assets.json() as { items: Array<{ id: string }> }).items.map((item) => item.id), [data.assetId]);
    const request = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/publisher/requests`, payload: { accountId: data.accountId, idempotencyKey: `publisher-foreign-asset-${randomUUID()}`, correlationId: `correlation-${randomUUID()}`, revision: { assetId: foreignAssetId, assetChecksum: foreignChecksum, title: '跨项目发布', description: '', desiredPublishAt: null, createdBy: 'operator' } } });
    assert.equal(request.statusCode, 422);
    assert.equal((request.json() as { error: { code: string } }).error.code, 'PUBLISHER_ASSET_INVALID');
    const mismatch = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/publisher/requests`, payload: { accountId: data.accountId, idempotencyKey: `publisher-mismatch-asset-${randomUUID()}`, correlationId: `correlation-${randomUUID()}`, revision: { assetId: data.assetId, assetChecksum: 'sha256:not-real', title: '校验值错误', description: '', desiredPublishAt: null, createdBy: 'operator' } } });
    assert.equal(mismatch.statusCode, 422);
    assert.equal((mismatch.json() as { error: { code: string } }).error.code, 'PUBLISHER_ASSET_INVALID');
  } finally {
    await app.close();
    if (projectId) await cleanup(db, projectId);
    if (foreignProjectId) { await db.query('delete from assets where project_id = $1', [foreignProjectId]); await db.query('delete from content_projects where id = $1', [foreignProjectId]); }
    await db.end();
  }
});

test('Publisher queue remains idempotent under concurrent duplicate requests', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  const app = await buildApi(db);
  try {
    const data = await fixture(db);
    projectId = data.projectId;
    const createRequest = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/publisher/requests`, payload: { accountId: data.accountId, idempotencyKey: `publisher-concurrent-${randomUUID()}`, correlationId: `correlation-${randomUUID()}`, revision: { assetId: data.assetId, assetChecksum: data.checksum, title: '并发发布', description: '', desiredPublishAt: null, createdBy: 'operator' } } });
    const body = createRequest.json() as { request: { id: string }; revision: { id: string } };
    const approval = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/approvals`, payload: { targetType: 'PUBLISH', targetId: body.request.id, targetRevisionId: body.revision.id, status: 'PENDING', approver: 'operator' } });
    assert.equal(approval.statusCode, 201);
    const approved = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/approvals/PUBLISH/${body.request.id}/${body.revision.id}/approve`, payload: { approver: 'operator' } });
    assert.equal(approved.statusCode, 200);
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/publisher/requests/${body.request.id}/queue` }),
      app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/publisher/requests/${body.request.id}/queue` }),
    ]);
    assert.deepEqual(responses.map((response) => response.statusCode), [202, 202]);
    assert.equal((responses[0].json() as { jobId: string }).jobId, (responses[1].json() as { jobId: string }).jobId);
    const jobs = await db.query('select id from jobs where project_id = $1 and type = $2', [projectId, 'PUBLISH']);
    assert.equal(jobs.rowCount, 1);
  } finally {
    await app.close();
    if (projectId) await cleanup(db, projectId);
    await db.end();
  }
});

test('Publisher request API projects safe attempt fields without diagnostics', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  const app = await buildApi(db);
  try {
    const data = await fixture(db);
    projectId = data.projectId;
    const publisher = new PublisherService(db);
    const created = await publisher.createRequest({ projectId, accountId: data.accountId, idempotencyKey: `publisher-safe-attempt-${randomUUID()}`, correlationId: `correlation-${randomUUID()}`, revision: { assetId: data.assetId, assetChecksum: data.checksum, title: '安全诊断', description: '', desiredPublishAt: null, createdBy: 'test' } });
    const attempt = await publisher.startAttempt({ requestId: created.request.id, revisionId: created.revision.id, operation: 'PUBLISH', jobId: null, jobAttemptId: null });
    await publisher.finishAttempt(attempt.id, { status: 'FAILED', failureCode: 'AUTH_EXPIRED', failureClassification: 'HUMAN_ACTION_REQUIRED', diagnostics: { token: 'must-not-leak' } });
    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/publisher/requests/${created.request.id}` });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.stringify(response.json()).includes('must-not-leak'), false);
    assert.equal((response.json() as { attempts: Array<{ failureCode: string }> }).attempts[0]?.failureCode, 'AUTH_EXPIRED');
  } finally {
    await app.close();
    if (projectId) await cleanup(db, projectId);
    await db.end();
  }
});
