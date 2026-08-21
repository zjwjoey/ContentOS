import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReviewDecision, type ReviewDecisionV0 } from '../../packages/contracts/src/index.js';

const pending: ReviewDecisionV0 = { schemaVersion: 'REVIEW_V0', projectId: 'project-review', targetType: 'RENDER', targetId: 'render-1', status: 'PENDING', reviewer: 'operator-1', evidence: { outputChecked: true } };

test('REVIEW_V0 accepts pending and approved decisions', () => {
  assert.doesNotThrow(() => validateReviewDecision(pending));
  assert.doesNotThrow(() => validateReviewDecision({ ...pending, status: 'APPROVED' }));
});

test('REVIEW_V0 requires a reason for rejection and valid target metadata', () => {
  assert.throws(() => validateReviewDecision({ ...pending, status: 'REJECTED' }), /reason/);
  assert.throws(() => validateReviewDecision({ ...pending, targetType: 'UNKNOWN' } as unknown as ReviewDecisionV0), /targetType/);
  assert.throws(() => validateReviewDecision({ ...pending, reviewer: '' }), /reviewer/);
});
