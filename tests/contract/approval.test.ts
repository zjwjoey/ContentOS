import test from 'node:test';
import assert from 'node:assert/strict';
import { validateApprovalDecision, type ApprovalDecisionV0 } from '../../packages/contracts/src/index.js';

const pending: ApprovalDecisionV0 = {
  schemaVersion: 'APPROVAL_V0',
  projectId: 'project-approval',
  targetType: 'PUBLISH',
  targetId: 'publisher-request-1',
  targetRevisionId: 'publisher-revision-1',
  status: 'PENDING',
  approver: 'operator-1',
  evidence: { titleChecked: true },
};

test('APPROVAL_V0 binds a decision to a concrete target revision', () => {
  assert.doesNotThrow(() => validateApprovalDecision(pending));
  assert.doesNotThrow(() => validateApprovalDecision({ ...pending, status: 'APPROVED' }));
  assert.throws(() => validateApprovalDecision({ ...pending, targetRevisionId: '' }), /targetRevisionId/);
});

test('APPROVAL_V0 requires a rejection reason and bounded identifiers', () => {
  assert.throws(() => validateApprovalDecision({ ...pending, status: 'REJECTED' }), /reason/);
  assert.throws(() => validateApprovalDecision({ ...pending, targetType: 'UNKNOWN' } as unknown as ApprovalDecisionV0), /targetType/);
  assert.throws(() => validateApprovalDecision({ ...pending, approver: '' }), /approver/);
});

test('APPROVAL_V0 only formalizes Render and Publish targets', () => {
  assert.throws(() => validateApprovalDecision({ ...pending, targetType: 'SCRIPT' as never }), /formal approval target/);
  assert.throws(() => validateApprovalDecision({ ...pending, targetType: 'STORYBOARD' as never }), /formal approval target/);
});
