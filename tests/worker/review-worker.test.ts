import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeMetricsSource } from '../../packages/modules/review/src/fake-metrics-source.js';
import { createReviewJobHandler } from '../../workers/review-worker/src/handler.js';
import { REVIEW_COLLECT_METRICS } from '../../packages/modules/review/src/index.js';

test('Fake metrics source is deterministic in values and classifies unavailable as retryable', async () => {
  const post = { id: 'post-1', requestId: 'request-1', accountId: 'account-1', platformId: 'fake-platform', externalPostId: 'external-1', externalUrl: null, firstObservedAt: '2026-08-30T12:00:00.000Z', lastReconciledAt: null };
  const first = await new FakeMetricsSource().collect(post);
  const second = await new FakeMetricsSource().collect(post);
  assert.deepEqual(first.metrics, second.metrics);
  assert.ok(Object.values(first.metrics).every((value) => Number.isSafeInteger(value) && value >= 0));
  await assert.rejects(() => new FakeMetricsSource('UNAVAILABLE').collect(post), (error: unknown) => (error as { retryable?: boolean }).retryable === true);
});

test('Review worker rejects malformed ownership payloads before collecting', async () => {
  const handler = createReviewJobHandler({ jobs: {} as never, analytics: {} as never, posts: { getExternalPost: async () => null }, metricsSource: new FakeMetricsSource() });
  await assert.rejects(() => handler({ id: 'job', projectId: 'project', workspaceId: null, type: REVIEW_COLLECT_METRICS, state: 'RUNNING', payload: { schemaVersion: 'bad', projectId: 'other' }, result: null, error: null, attemptCount: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, progress: {} }, 'attempt', new AbortController().signal), /Invalid Review metric collection/);
});

