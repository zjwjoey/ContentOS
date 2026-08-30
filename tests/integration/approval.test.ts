import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ApprovalService } from '../../packages/modules/approval/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

test('Approval binds publish approval to one concrete Publisher Revision', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  try {
    await migrateUp(db);
    const project = await new ProjectService(db).create(`Approval ${randomUUID()}`);
    projectId = project.id;
    const approvals = new ApprovalService(db);
    const pending = await approvals.create({ projectId, targetType: 'PUBLISH', targetId: 'publisher-request-1', targetRevisionId: 'publisher-revision-1', status: 'PENDING', approver: 'operator' });
    assert.equal(pending.targetRevisionId, 'publisher-revision-1');
    const approved = await approvals.approve(projectId, 'PUBLISH', pending.targetId, pending.targetRevisionId, 'lead');
    assert.equal(approved.status, 'APPROVED');
    assert.equal((await approvals.getCurrent(projectId, 'PUBLISH', pending.targetId, 'publisher-revision-2')), null);
    await assert.rejects(() => approvals.approve(projectId, 'PUBLISH', pending.targetId, pending.targetRevisionId, 'lead'), /must be PENDING/);
  } finally {
    if (projectId) await db.query('delete from approval_decisions where project_id = $1', [projectId]);
    if (projectId) await db.query('delete from content_projects where id = $1', [projectId]);
    await db.end();
  }
});
