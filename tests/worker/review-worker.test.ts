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

test('Review worker rejects incomplete snapshot sets and persists validated analysis reports', async () => {
  const reports: unknown[] = [];
  const analytics = {
    getMetricSnapshots: async () => [{ schemaVersion: 'METRIC_SNAPSHOT_V1', id: 'snapshot-1', projectId: 'project', externalPostId: 'post', platformId: 'fake-platform', capturedAt: '2026-08-30T12:00:00.000Z', publishedAt: null, metrics: { plays: 100, likes: 10, comments: 1, saves: 2, shares: 1 }, source: 'FAKE', sourceReference: 'fake', createdAt: '2026-08-30T12:00:00.000Z' }],
    recordAnalysisReport: async (report: unknown) => { reports.push(report); return report; },
  };
  const jobs = { succeedWithCurrentAttempt: async (_id: string, _attempt: string, action: () => Promise<unknown>) => ({ executed: true, value: await action(), job: {} }) };
  const posts = { getExternalPost: async () => ({ id: 'post', requestId: 'request', accountId: 'account', platformId: 'fake-platform', externalPostId: 'external', externalUrl: null, firstObservedAt: '2026-08-30T12:00:00.000Z', lastReconciledAt: null }) };
  const ai = { generateStructured: async (_input: unknown, validator: (value: unknown) => unknown) => ({ aiRunId: 'ai-run', output: validator({ summary: 'summary', highlights: [{ title: 'h', detail: 'd' }], risks: [], recommendations: [{ priority: 'LOW', title: 'r', detail: 'd' }] }) }) };
  const handler = createReviewJobHandler({ jobs: jobs as never, analytics: analytics as never, posts, metricsSource: new FakeMetricsSource(), ai: ai as never });
  const job = { id: 'job', projectId: 'project', workspaceId: null, type: 'REVIEW_GENERATE_ANALYSIS', state: 'RUNNING', payload: { schemaVersion: 'REVIEW_ANALYSIS_JOB_V1', projectId: 'project', externalPostId: 'post', metricSnapshotIds: ['snapshot-1'], correlationId: 'corr' }, result: null, error: null, attemptCount: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, progress: {} } as never;
  const result = await handler(job, 'attempt', new AbortController().signal);
  assert.equal((result as { status: string }).status, 'RECORDED');
  assert.equal(reports.length, 1);
});
