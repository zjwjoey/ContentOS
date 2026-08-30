import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ApprovalService } from '../../packages/modules/approval/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { PublisherService } from '../../packages/modules/publisher/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

test('Approval binds publish approval to one concrete Publisher Revision', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  let requestId = '';
  let assetId = '';
  try {
    await migrateUp(db);
    const project = await new ProjectService(db).create(`Approval ${randomUUID()}`);
    projectId = project.id;
    assetId = `approval-asset-${randomUUID()}`;
    await db.query(
      "insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle) values ($1, $2, 'VIDEO_RENDER', $3, 1, $4, 'READY')",
      [assetId, projectId, `approval-checksum-${assetId}`, `approval/${assetId}.mp4`],
    );
    const publisher = new PublisherService(db);
    const account = await publisher.createAccount({
      projectId,
      platformId: 'fake-platform',
      displayName: `Approval ${randomUUID()}`,
      credentialRef: 'test-ref',
      profileKey: `approval-profile-${randomUUID()}`,
      status: 'READY',
      capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false },
    });
    const request = await publisher.createRequest({
      projectId,
      accountId: account.id,
      idempotencyKey: `approval-request-${randomUUID()}`,
      correlationId: `approval-correlation-${randomUUID()}`,
      revision: {
        assetId,
        assetChecksum: `approval-checksum-${assetId}`,
        title: 'Approval target',
        description: '',
        desiredPublishAt: null,
        createdBy: 'operator',
      },
    });
    requestId = request.request.id;
    const approvals = new ApprovalService(db);
    const pending = await approvals.create({
      projectId,
      targetType: 'PUBLISH',
      targetId: request.request.id,
      targetRevisionId: request.revision.id,
      status: 'PENDING',
      approver: 'operator',
    });
    assert.equal(pending.targetRevisionId, request.revision.id);
    const approved = await approvals.approve(projectId, 'PUBLISH', pending.targetId, pending.targetRevisionId, 'lead');
    assert.equal(approved.status, 'APPROVED');
    assert.equal(await approvals.getCurrent(projectId, 'PUBLISH', pending.targetId, `stale-${request.revision.id}`), null);
    await assert.rejects(() => approvals.approve(projectId, 'PUBLISH', pending.targetId, pending.targetRevisionId, 'lead'), /must be PENDING/);
    await assert.rejects(
      () =>
        approvals.create({
          projectId,
          targetType: 'PUBLISH',
          targetId: request.request.id,
          targetRevisionId: request.revision.id,
          status: 'APPROVED',
          approver: 'operator',
        }),
      /only supports PENDING/,
    );
    await assert.rejects(
      () =>
        approvals.create({
          projectId,
          targetType: 'PUBLISH',
          targetId: request.request.id,
          targetRevisionId: `stale-${request.revision.id}`,
          status: 'PENDING',
          approver: 'operator',
        }),
      /current project artifact/,
    );
  } finally {
    if (projectId) await db.query('delete from approval_decisions where project_id = $1', [projectId]);
    if (requestId) await db.query('update publisher_requests set current_revision_id = null where id = $1', [requestId]);
    if (requestId) await db.query('delete from publisher_request_revisions where request_id = $1', [requestId]);
    if (requestId) await db.query('delete from publisher_requests where id = $1', [requestId]);
    if (projectId) await db.query('delete from publisher_accounts where project_id = $1', [projectId]);
    if (assetId) await db.query('delete from assets where id = $1', [assetId]);
    if (projectId) await db.query('delete from content_projects where id = $1', [projectId]);
    await db.end();
  }
});

test('Approval transitions serialize concurrent terminal decisions for one target', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  let requestId = '';
  let assetId = '';
  try {
    await migrateUp(db);
    const project = await new ProjectService(db).create(`Approval race ${randomUUID()}`);
    projectId = project.id;
    assetId = `approval-race-asset-${randomUUID()}`;
    const checksum = `approval-race-checksum-${assetId}`;
    await db.query(
      "insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle) values ($1, $2, 'VIDEO_RENDER', $3, 1, $4, 'READY')",
      [assetId, projectId, checksum, `approval/${assetId}.mp4`],
    );
    const publisher = new PublisherService(db);
    const account = await publisher.createAccount({
      projectId,
      platformId: 'fake-platform',
      displayName: `Approval Race ${randomUUID()}`,
      credentialRef: 'test-ref',
      profileKey: `approval-race-profile-${randomUUID()}`,
      status: 'READY',
      capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false },
    });
    const request = await publisher.createRequest({
      projectId,
      accountId: account.id,
      idempotencyKey: `approval-race-request-${randomUUID()}`,
      correlationId: `approval-race-correlation-${randomUUID()}`,
      revision: { assetId, assetChecksum: checksum, title: 'Approval race', description: '', desiredPublishAt: null, createdBy: 'operator' },
    });
    requestId = request.request.id;
    const approvals = new ApprovalService(db);
    await approvals.create({
      projectId,
      targetType: 'PUBLISH',
      targetId: request.request.id,
      targetRevisionId: request.revision.id,
      status: 'PENDING',
      approver: 'operator',
    });
    const results = await Promise.allSettled([
      approvals.approve(projectId, 'PUBLISH', request.request.id, request.revision.id, 'operator-a'),
      approvals.reject(projectId, 'PUBLISH', request.request.id, request.revision.id, 'operator-b', '并发拒绝'),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const decisions = await db.query<{ revision: number; status: string }>(
      'select revision, status from approval_decisions where project_id = $1 and target_id = $2 order by revision',
      [projectId, request.request.id],
    );
    assert.deepEqual(
      decisions.rows.map((row) => row.revision),
      [1, 2],
    );
    assert.notEqual(decisions.rows[1]?.status, 'PENDING');
  } finally {
    if (projectId) await db.query('delete from approval_decisions where project_id = $1', [projectId]);
    if (requestId) await db.query('update publisher_requests set current_revision_id = null where id = $1', [requestId]);
    if (requestId) await db.query('delete from publisher_request_revisions where request_id = $1', [requestId]);
    if (requestId) await db.query('delete from publisher_requests where id = $1', [requestId]);
    if (projectId) await db.query('delete from publisher_accounts where project_id = $1', [projectId]);
    if (assetId) await db.query('delete from assets where id = $1', [assetId]);
    if (projectId) await db.query('delete from content_projects where id = $1', [projectId]);
    await db.end();
  }
});
