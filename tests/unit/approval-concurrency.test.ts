import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalService } from '../../packages/modules/approval/src/index.js';

test('Approval creation uses a transaction advisory lock for revision allocation', async () => {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes('from publisher_requests')) return { rows: [{ id: 'request-1' }] };
      if (sql.includes('coalesce(max(revision)')) return { rows: [{ revision: 1 }] };
      if (sql.includes('returning *'))
        return {
          rows: [
            {
              id: 'approval-1',
              project_id: 'project-1',
              target_type: 'PUBLISH',
              target_id: 'request-1',
              target_revision_id: 'revision-1',
              revision: 1,
              status: 'PENDING',
              approver: 'operator',
              evidence: {},
              created_at: new Date().toISOString(),
            },
          ],
        };
      return { rows: [] };
    },
    release() {},
  };
  const db = { connect: async () => client };
  const projects = { get: async () => ({ id: 'project-1' }) };
  const service = new ApprovalService(db as never, projects as never);
  await service.create({
    projectId: 'project-1',
    targetType: 'PUBLISH',
    targetId: 'request-1',
    targetRevisionId: 'revision-1',
    status: 'PENDING',
    approver: 'operator',
  });
  assert.ok(statements.includes('begin'));
  assert.ok(statements.some((statement) => statement.includes('pg_advisory_xact_lock')));
  assert.ok(statements.includes('commit'));
});

test('Approval transition locks and re-reads the current decision in the same transaction', async () => {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes('select * from approval_decisions')) {
        return {
          rows: [
            {
              id: 'approval-pending',
              project_id: 'project-1',
              target_type: 'PUBLISH',
              target_id: 'request-1',
              target_revision_id: 'revision-1',
              revision: 1,
              status: 'PENDING',
              approver: 'system',
              evidence: { checked: true },
              created_at: new Date().toISOString(),
            },
          ],
        };
      }
      if (sql.includes('coalesce(max(revision)')) return { rows: [{ revision: 2 }] };
      if (sql.includes('returning *'))
        return {
          rows: [
            {
              id: 'approval-approved',
              project_id: 'project-1',
              target_type: 'PUBLISH',
              target_id: 'request-1',
              target_revision_id: 'revision-1',
              revision: 2,
              status: 'APPROVED',
              approver: 'operator',
              evidence: { checked: true },
              created_at: new Date().toISOString(),
            },
          ],
        };
      return { rows: [] };
    },
    release() {},
  };
  const db = { connect: async () => client };
  const projects = { get: async () => ({ id: 'project-1' }) };
  const service = new ApprovalService(db as never, projects as never);

  const result = await service.approve('project-1', 'PUBLISH', 'request-1', 'revision-1', 'operator');
  assert.equal(result.status, 'APPROVED');
  const lockIndex = statements.findIndex((statement) => statement.includes('pg_advisory_xact_lock'));
  const currentIndex = statements.findIndex((statement) => statement.includes('select * from approval_decisions'));
  const commitIndex = statements.indexOf('commit');
  assert.ok(lockIndex >= 0 && currentIndex > lockIndex && commitIndex > currentIndex);
});
