import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { PublisherService } from '../../packages/modules/publisher/src/index.js';
import { ApprovalService } from '../../packages/modules/approval/src/index.js';
import { DirectorService } from '../../packages/modules/director/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

async function cleanupProject(db: Awaited<ReturnType<typeof createDatabase>>, projectId: string): Promise<void> {
  await db.query('update publisher_requests set current_revision_id = null where project_id = $1', [projectId]);
  await db.query('delete from publisher_external_posts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_attempts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_request_revisions where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_requests where project_id = $1', [projectId]);
  await db.query('delete from publisher_accounts where project_id = $1', [projectId]);
  await db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [projectId]);
  await db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [projectId]);
  await db.query('delete from jobs where project_id = $1', [projectId]);
  await db.query('delete from approval_decisions where project_id = $1', [projectId]);
  await db.query('update content_projects set current_director_revision_id = null where id = $1', [projectId]);
  await db.query('delete from director_plan_revisions where project_id = $1', [projectId]);
  await db.query('delete from assets where project_id = $1', [projectId]);
  await db.query('delete from content_projects where id = $1', [projectId]);
}

test('Project Center returns a safe empty-project snapshot', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create('Project Center Empty ' + randomUUID());
  const app = await buildApi(db);
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { project: { id: string }; health: { level: string }; currentStage: string; stages: unknown[] };
    assert.equal(body.project.id, project.id);
    assert.equal(body.health.level, 'HEALTHY');
    assert.equal(body.currentStage, 'DIRECTOR');
    assert.equal(body.stages.length, 4);
    assert.equal(JSON.stringify(body).includes('payload'), false);
    assert.equal(JSON.stringify(body).includes('credentialRef'), false);
  } finally {
    await app.close();
    await cleanupProject(db, project.id);
    await db.end();
  }
});

test('Project Center maps Director, failed Video Job, pending Approval and Publisher human action', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create('Project Center states ' + randomUUID());
  const app = await buildApi(db);
  const director = new DirectorService(db);
  const jobs = new JobService(db);
  const approvals = new ApprovalService(db);
  const publisher = new PublisherService(db);
  try {
    const initial = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(initial.json().currentStage, 'DIRECTOR');
    const plan = {
      schemaVersion: 'DIRECTOR_PLAN_V0' as const,
      projectId: project.id,
      seed: 7,
      brief: { topic: '测试', audience: '运营', objective: '验证', tone: '清晰' },
      storyboard: [{ id: 'scene-1', title: '开场', narration: '内容', visualIntent: '画面', durationMs: 1000, sourceAssetIds: [] }],
      provenance: { author: 'test', source: 'manual' as const },
    };
    const revision = await director.createDraft(project.id, plan);
    await director.accept(project.id, revision.revision);
    await director.approveStoryboard(project.id, revision.revision);
    const afterDirector = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(afterDirector.json().stages[0].status, 'COMPLETE');
    assert.equal(afterDirector.json().currentStage, 'VIDEO');
    const job = await jobs.create({ id: 'job-center-failed-' + randomUUID(), type: 'VIDEO_RENDER', projectId: project.id, payload: { safe: true }, idempotencyKey: 'center-failed-' + randomUUID(), maxAttempts: 1 });
    const failed = await jobs.claim(job.id, 'center-test', 30_000);
    assert.ok(failed);
    await jobs.fail(job.id, failed!.attemptId, { code: 'RENDER_FAILED' }, false);
    const afterFailure = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(afterFailure.json().health.level, 'BLOCKED');
    assert.equal(afterFailure.json().stages[1].status, 'BLOCKED');
    const pending = await approvals.create({ projectId: project.id, targetType: 'RENDER', targetId: 'render-' + project.id, targetRevisionId: revision.id, status: 'PENDING', approver: 'operator' });
    assert.equal(pending.status, 'PENDING');
    const account = await publisher.createAccount({ projectId: project.id, platformId: 'fake-platform', displayName: 'Fake', credentialRef: 'server-ref', profileKey: 'server-profile', status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false } });
    const assetId = 'asset-center-' + randomUUID();
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO_RENDER', 'sha256:center', 100, 'renders/' + assetId + '.mp4', 'READY', { width: 1080, height: 1920 }]);
    const request = await publisher.createRequest({ projectId: project.id, accountId: account.id, idempotencyKey: 'center-request-' + randomUUID(), correlationId: 'center-correlation-' + randomUUID(), revision: { assetId, assetChecksum: 'sha256:center', title: '测试', description: '', desiredPublishAt: null, createdBy: 'operator' } });
    const attempt = await publisher.startAttempt({ requestId: request.request.id, revisionId: request.revision.id, operation: 'PUBLISH', jobId: null, jobAttemptId: null });
    await publisher.finishAttempt(attempt.id, { status: 'FAILED', failureCode: 'AUTH_EXPIRED', failureClassification: 'HUMAN_ACTION_REQUIRED', diagnostics: { secret: 'not exposed' } });
    const afterHuman = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(afterHuman.json().health.level, 'BLOCKED');
    assert.equal(afterHuman.json().stages[3].status, 'ACTION_REQUIRED');
    assert.equal(JSON.stringify(afterHuman.json()).includes('server-ref'), false);
    assert.equal(JSON.stringify(afterHuman.json()).includes('not exposed'), false);
  } finally {
    await app.close();
    await cleanupProject(db, project.id);
    await db.end();
  }
});

test('Project Center returns 404 for an unknown project', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const app = await buildApi(db);
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/project-missing-' + randomUUID() + '/center' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'PROJECT_NOT_FOUND');
  } finally {
    await app.close();
    await db.end();
  }
});

test('Project Center reports a confirmed Publisher post as complete', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create('Project Center published ' + randomUUID());
  const publisher = new PublisherService(db);
  const app = await buildApi(db);
  try {
    const assetId = 'asset-center-published-' + randomUUID();
    const checksum = 'sha256:published';
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO_RENDER', checksum, 100, 'renders/' + assetId + '.mp4', 'READY', { width: 1080, height: 1920 }]);
    const account = await publisher.createAccount({ projectId: project.id, platformId: 'fake-platform', displayName: 'Fake Published', credentialRef: 'server-ref', profileKey: 'server-profile', status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false } });
    const request = await publisher.createRequest({ projectId: project.id, accountId: account.id, idempotencyKey: 'center-published-' + randomUUID(), correlationId: 'center-published-correlation-' + randomUUID(), revision: { assetId, assetChecksum: checksum, title: '已发布', description: '', desiredPublishAt: null, createdBy: 'operator' } });
    await publisher.transitionRequest(request.request.id, 'QUEUED');
    await publisher.transitionRequest(request.request.id, 'PUBLISHING');
    await publisher.transitionRequest(request.request.id, 'PUBLISHED');
    await publisher.recordExternalPost({ requestId: request.request.id, accountId: account.id, platformId: account.platformId, externalPostId: 'external-' + randomUUID(), externalUrl: 'https://fake.example/post' });
    await new ProjectService(db).syncPublishingStatus(project.id, { hasPublishableAsset: true, publishedRequestCount: 1 });
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.health.level, 'COMPLETE');
    assert.equal(body.stages[3].status, 'COMPLETE');
  } finally {
    await app.close();
    await cleanupProject(db, project.id);
    await db.end();
  }
});
