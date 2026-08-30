import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { PublisherService } from '../../packages/modules/publisher/src/index.js';
import { ApprovalService } from '../../packages/modules/approval/src/index.js';
import { DirectorService } from '../../packages/modules/director/src/index.js';
import { DirectorV1Service } from '../../packages/modules/director/src/index.js';
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
  await db.query('delete from project_assets where project_id = $1', [projectId]);
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
    assert.equal(body.currentStage, 'ASSETS');
    assert.equal(body.stages.length, 5);
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
    assert.equal(initial.json().currentStage, 'ASSETS');
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
    assert.equal(afterDirector.json().stages[1].status, 'COMPLETE');
    assert.equal(afterDirector.json().currentStage, 'ASSETS');
    const job = await jobs.create({
      id: 'job-center-failed-' + randomUUID(),
      type: 'VIDEO_RENDER',
      projectId: project.id,
      payload: { safe: true },
      idempotencyKey: 'center-failed-' + randomUUID(),
      maxAttempts: 1,
    });
    const failed = await jobs.claim(job.id, 'center-test', 30_000);
    assert.ok(failed);
    await jobs.fail(job.id, failed!.attemptId, { code: 'RENDER_FAILED' }, false);
    const afterFailure = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(afterFailure.json().health.level, 'BLOCKED');
    assert.equal(afterFailure.json().stages[2].status, 'BLOCKED');
    await db.query(
      "insert into approval_decisions (id, project_id, target_type, target_id, target_revision_id, revision, schema_version, status, approver, evidence) values ($1, $2, 'RENDER', $3, $4, 1, 'APPROVAL_V0', 'PENDING', 'operator', '{}'::jsonb)",
      ['approval-legacy-' + project.id, project.id, 'render-legacy-' + project.id, revision.id],
    );
    const afterPending = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(
      afterPending.json().actions.some((action: { kind: string; id: string }) => action.kind === 'APPROVAL' && action.id.includes('RENDER')),
      false,
    );
    const account = await publisher.createAccount({
      projectId: project.id,
      platformId: 'fake-platform',
      displayName: 'Fake',
      credentialRef: 'server-ref',
      profileKey: 'server-profile',
      status: 'READY',
      capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false },
    });
    const assetId = 'asset-center-' + randomUUID();
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [
      assetId,
      project.id,
      'VIDEO_RENDER',
      'sha256:center',
      100,
      'renders/' + assetId + '.mp4',
      'READY',
      { width: 1080, height: 1920 },
    ]);
    const request = await publisher.createRequest({
      projectId: project.id,
      accountId: account.id,
      idempotencyKey: 'center-request-' + randomUUID(),
      correlationId: 'center-correlation-' + randomUUID(),
      revision: { assetId, assetChecksum: 'sha256:center', title: '测试', description: '', desiredPublishAt: null, createdBy: 'operator' },
    });
    const attempt = await publisher.startAttempt({
      requestId: request.request.id,
      revisionId: request.revision.id,
      operation: 'PUBLISH',
      jobId: null,
      jobAttemptId: null,
    });
    await publisher.finishAttempt(attempt.id, {
      status: 'FAILED',
      failureCode: 'AUTH_EXPIRED',
      failureClassification: 'HUMAN_ACTION_REQUIRED',
      diagnostics: { secret: 'not exposed' },
    });
    const afterHuman = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(afterHuman.json().health.level, 'BLOCKED');
    assert.equal(afterHuman.json().stages[4].status, 'ACTION_REQUIRED');
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
  const approvals = new ApprovalService(db);
  const app = await buildApi(db);
  try {
    const assetId = 'asset-center-published-' + randomUUID();
    const checksum = 'sha256:published';
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [
      assetId,
      project.id,
      'VIDEO_RENDER',
      checksum,
      100,
      'renders/' + assetId + '.mp4',
      'READY',
      { width: 1080, height: 1920 },
    ]);
    const account = await publisher.createAccount({
      projectId: project.id,
      platformId: 'fake-platform',
      displayName: 'Fake Published',
      credentialRef: 'server-ref',
      profileKey: 'server-profile',
      status: 'READY',
      capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false },
    });
    const request = await publisher.createRequest({
      projectId: project.id,
      accountId: account.id,
      idempotencyKey: 'center-published-' + randomUUID(),
      correlationId: 'center-published-correlation-' + randomUUID(),
      revision: { assetId, assetChecksum: checksum, title: '已发布', description: '', desiredPublishAt: null, createdBy: 'operator' },
    });
    await approvals.create({
      projectId: project.id,
      targetType: 'PUBLISH',
      targetId: request.request.id,
      targetRevisionId: request.revision.id,
      status: 'PENDING',
      approver: 'operator',
    });
    await approvals.approve(project.id, 'PUBLISH', request.request.id, request.revision.id, 'operator');
    await publisher.transitionRequest(request.request.id, 'QUEUED');
    await publisher.transitionRequest(request.request.id, 'PUBLISHING');
    await publisher.transitionRequest(request.request.id, 'PUBLISHED');
    await publisher.recordExternalPost({
      requestId: request.request.id,
      accountId: account.id,
      platformId: account.platformId,
      externalPostId: 'external-' + randomUUID(),
      externalUrl: 'https://fake.example/post',
    });
    await new ProjectService(db).syncPublishingStatus(project.id, { hasPublishableAsset: true, publishedRequestCount: 1 });
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.health.level, 'COMPLETE');
    assert.equal(body.stages[4].status, 'COMPLETE');
  } finally {
    await app.close();
    await cleanupProject(db, project.id);
    await db.end();
  }
});

test('Project Center only evaluates approval for the current Publisher revision', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create('Project Center current approval ' + randomUUID());
  const publisher = new PublisherService(db);
  const approvals = new ApprovalService(db);
  const app = await buildApi(db);
  try {
    const assetId = 'asset-center-approval-' + randomUUID();
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [
      assetId,
      project.id,
      'VIDEO_RENDER',
      'sha256:approval',
      100,
      'renders/' + assetId + '.mp4',
      'READY',
      { width: 1080, height: 1920 },
    ]);
    const account = await publisher.createAccount({
      projectId: project.id,
      platformId: 'fake-platform',
      displayName: 'Fake Approval',
      credentialRef: 'server-ref',
      profileKey: 'server-profile',
      status: 'READY',
      capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false },
    });
    const request = await publisher.createRequest({
      projectId: project.id,
      accountId: account.id,
      idempotencyKey: 'center-approval-' + randomUUID(),
      correlationId: 'center-approval-correlation-' + randomUUID(),
      revision: { assetId, assetChecksum: 'sha256:approval', title: '旧版本', description: '', desiredPublishAt: null, createdBy: 'operator' },
    });
    await approvals.create({
      projectId: project.id,
      targetType: 'PUBLISH',
      targetId: request.request.id,
      targetRevisionId: request.revision.id,
      status: 'PENDING',
      approver: 'operator',
    });
    await approvals.reject(project.id, 'PUBLISH', request.request.id, request.revision.id, 'operator', '需要修改');
    const currentRevision = await publisher.addRevision(request.request.id, {
      assetId,
      assetChecksum: 'sha256:approval',
      title: '新版本',
      description: '',
      desiredPublishAt: null,
      createdBy: 'operator',
    });
    await approvals.create({
      projectId: project.id,
      targetType: 'PUBLISH',
      targetId: request.request.id,
      targetRevisionId: currentRevision.id,
      status: 'PENDING',
      approver: 'operator',
    });
    await approvals.approve(project.id, 'PUBLISH', request.request.id, currentRevision.id, 'operator');
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(response.statusCode, 200, response.body);
    assert.notEqual(response.json().health.level, 'BLOCKED');
    assert.equal(response.json().stages[3].status, 'COMPLETE');
    const pendingRequest = await publisher.createRequest({
      projectId: project.id,
      accountId: account.id,
      idempotencyKey: 'center-approval-pending-' + randomUUID(),
      correlationId: 'center-approval-pending-correlation-' + randomUUID(),
      revision: { assetId, assetChecksum: 'sha256:approval', title: '待审批版本', description: '', desiredPublishAt: null, createdBy: 'operator' },
    });
    await approvals.create({
      projectId: project.id,
      targetType: 'PUBLISH',
      targetId: pendingRequest.request.id,
      targetRevisionId: pendingRequest.revision.id,
      status: 'PENDING',
      approver: 'operator',
    });
    const mixedResponse = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(mixedResponse.json().stages[3].status, 'ACTION_REQUIRED');
    assert.ok(mixedResponse.json().actions.some((action: { kind: string; id: string }) => action.kind === 'APPROVAL' && action.id === 'approval-pending'));
  } finally {
    await app.close();
    await cleanupProject(db, project.id);
    await db.end();
  }
});

test('Project Center follows Director V1 current targets and ignores superseded approvals', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create('Project Center Director V1 ' + randomUUID());
  const director = new DirectorV1Service(db);
  const approvals = new ApprovalService(db);
  const app = await buildApi(db);
  try {
    const brief = await director.createBrief(project.id, {
      topic: '主题',
      targetPlatform: 'douyin',
      channelPositioning: '栏目',
      targetDurationSeconds: 30,
      contentType: 'knowledge',
      audience: '运营',
      coreThesis: '先验证',
      tone: '清晰',
      referenceMaterial: '材料',
      mustInclude: ['反例'],
      mustAvoid: ['夸大'],
      requirements: {},
      createdBy: 'operator',
    });
    const scriptAggregate = await director.createScript(project.id, brief.id);
    const firstScript = await director.createScriptRevision(project.id, scriptAggregate.id, {
      origin: 'MANUAL',
      title: '旧脚本',
      titleCandidates: ['旧脚本'],
      coverText: '旧',
      topicKeywords: ['主题'],
      hook: '开头',
      body: '正文',
      createdBy: 'operator',
    });
    await director.acceptScript(project.id, firstScript.id);
    const firstBoardAggregate = await director.createStoryboard(project.id);
    const firstBoard = await director.createStoryboardRevision(project.id, firstBoardAggregate.id, {
      origin: 'MANUAL',
      scriptRevisionId: firstScript.id,
      scenes: [{ sceneIndex: 1, voiceoverText: '旧', durationHintSeconds: 2, visualInstruction: '旧画面', assetKeywords: ['旧'] }],
      createdBy: 'operator',
    });
    await director.approveStoryboard(project.id, firstBoard.id);
    await db.query(
      'insert into approval_decisions (id, project_id, target_type, target_id, target_revision_id, revision, schema_version, status, approver, reason) values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9)',
      [`legacy-script-${randomUUID()}`, project.id, 'SCRIPT', scriptAggregate.id, firstScript.id, 'APPROVAL_V0', 'REJECTED', 'operator', '旧版本'],
    );
    await db.query(
      'insert into approval_decisions (id, project_id, target_type, target_id, target_revision_id, revision, schema_version, status, approver, reason) values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9)',
      [`legacy-storyboard-${randomUUID()}`, project.id, 'STORYBOARD', firstBoardAggregate.id, firstBoard.id, 'APPROVAL_V0', 'REJECTED', 'operator', '旧版本'],
    );
    const secondScript = await director.createManualScriptRevision(
      project.id,
      firstScript.id,
      {
        origin: 'MANUAL',
        title: '新脚本',
        titleCandidates: ['新脚本'],
        coverText: '新',
        topicKeywords: ['主题'],
        hook: '新开头',
        body: '新正文',
        createdBy: 'operator',
      },
      'operator',
    );
    await director.acceptScript(project.id, secondScript.id);
    const secondBoardAggregate = await director.createStoryboard(project.id);
    const secondBoard = await director.createStoryboardRevision(project.id, secondBoardAggregate.id, {
      origin: 'MANUAL',
      scriptRevisionId: secondScript.id,
      scenes: [{ sceneIndex: 1, voiceoverText: '新', durationHintSeconds: 2, visualInstruction: '新画面', assetKeywords: ['新'] }],
      createdBy: 'operator',
    });
    await director.approveStoryboard(project.id, secondBoard.id);
    await db.query(
      'insert into approval_decisions (id, project_id, target_type, target_id, target_revision_id, revision, schema_version, status, approver) values ($1, $2, $3, $4, $5, 1, $6, $7, $8)',
      [`legacy-script-current-${randomUUID()}`, project.id, 'SCRIPT', scriptAggregate.id, secondScript.id, 'APPROVAL_V0', 'APPROVED', 'operator'],
    );
    await db.query(
      'insert into approval_decisions (id, project_id, target_type, target_id, target_revision_id, revision, schema_version, status, approver) values ($1, $2, $3, $4, $5, 1, $6, $7, $8)',
      [`legacy-storyboard-current-${randomUUID()}`, project.id, 'STORYBOARD', secondBoardAggregate.id, secondBoard.id, 'APPROVAL_V0', 'APPROVED', 'operator'],
    );
    const renderAssetId = 'asset-v1-render-' + randomUUID();
    const renderChecksum = 'sha256:v1-render-' + randomUUID();
    const manifestId = 'manifest-v1-render-' + randomUUID();
    const renderId = 'render-v1-' + randomUUID();
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [
      renderAssetId,
      project.id,
      'VIDEO_RENDER',
      renderChecksum,
      100,
      'renders/' + renderAssetId + '.mp4',
      'READY',
      {},
    ]);
    await db.query('insert into edit_manifests (id, project_id, revision, schema_version, manifest, status) values ($1, $2, $3, $4, $5, $6)', [
      manifestId,
      project.id,
      1,
      'EDIT_MANIFEST_V0',
      {},
      'PERSISTED',
    ]);
    await db.query('insert into renders (id, project_id, manifest_id, status, output_asset_id, finished_at) values ($1, $2, $3, $4, $5, now())', [
      renderId,
      project.id,
      manifestId,
      'SUCCEEDED',
      renderAssetId,
    ]);
    await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3)', [project.id, renderAssetId, 'RENDER']);
    await approvals.create({
      projectId: project.id,
      targetType: 'RENDER',
      targetId: renderId,
      targetRevisionId: renderAssetId,
      status: 'PENDING',
      approver: 'operator',
    });
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().stages[0].status, 'READY');
    assert.equal(response.json().stages[3].status, 'ACTION_REQUIRED');
    assert.notEqual(response.json().health.level, 'BLOCKED');
    assert.equal(
      response.json().actions.some((action: { id: string }) => action.id === 'approval-pending-RENDER'),
      true,
    );
    assert.equal(
      response.json().actions.some((action: { id: string }) => action.id.includes('SCRIPT') || action.id.includes('STORYBOARD')),
      false,
    );
  } finally {
    await app.close();
    await db.query('delete from approval_decisions where project_id = $1', [project.id]);
    await db.query('delete from renders where project_id = $1', [project.id]);
    await db.query('delete from edit_manifests where project_id = $1', [project.id]);
    await db.query('delete from project_assets where project_id = $1', [project.id]);
    await db.query('delete from assets where project_id = $1', [project.id]);
    await db.query('delete from director_project_state where project_id = $1', [project.id]);
    await db.query('delete from director_storyboard_revisions where project_id = $1', [project.id]);
    await db.query('delete from director_storyboards where project_id = $1', [project.id]);
    await db.query('delete from director_script_revisions where project_id = $1', [project.id]);
    await db.query('delete from director_scripts where project_id = $1', [project.id]);
    await db.query('delete from director_briefs where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end();
  }
});

test('Project Center ignores Approval decisions for cancelled Publisher requests', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create('Project Center cancelled approval ' + randomUUID());
  const publisher = new PublisherService(db);
  const approvals = new ApprovalService(db);
  const app = await buildApi(db);
  try {
    const assetId = 'asset-center-cancelled-' + randomUUID();
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [
      assetId,
      project.id,
      'VIDEO_RENDER',
      'sha256:cancelled',
      100,
      'renders/' + assetId + '.mp4',
      'READY',
      {},
    ]);
    const account = await publisher.createAccount({
      projectId: project.id,
      platformId: 'fake-platform',
      displayName: 'Cancelled Approval',
      credentialRef: 'server-ref',
      profileKey: 'server-profile',
      status: 'READY',
      capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false },
    });
    const request = await publisher.createRequest({
      projectId: project.id,
      accountId: account.id,
      idempotencyKey: 'center-cancelled-' + randomUUID(),
      correlationId: 'center-cancelled-correlation-' + randomUUID(),
      revision: { assetId, assetChecksum: 'sha256:cancelled', title: '已取消', description: '', desiredPublishAt: null, createdBy: 'operator' },
    });
    await approvals.create({
      projectId: project.id,
      targetType: 'PUBLISH',
      targetId: request.request.id,
      targetRevisionId: request.revision.id,
      status: 'PENDING',
      approver: 'operator',
    });
    await approvals.reject(project.id, 'PUBLISH', request.request.id, request.revision.id, 'operator', '不再发布');
    await publisher.transitionRequest(request.request.id, 'CANCELLED');
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/' + project.id + '/center' });
    assert.equal(response.statusCode, 200, response.body);
    assert.notEqual(response.json().health.level, 'BLOCKED');
    assert.equal(response.json().stages[2].status, 'NOT_STARTED');
    assert.equal(
      response.json().actions.some((action: { id: string }) => action.id === 'approval-rejected'),
      false,
    );
  } finally {
    await app.close();
    await cleanupProject(db, project.id);
    await db.end();
  }
});
