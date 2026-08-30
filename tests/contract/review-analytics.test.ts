import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMetricSnapshotV1,
  validateReviewAnalysisReportV1,
  type MetricSnapshotV1,
  type ReviewAnalysisReportV1,
} from '../../packages/contracts/src/index.js';

const validSnapshot: MetricSnapshotV1 = {
  schemaVersion: 'METRIC_SNAPSHOT_V1',
  id: 'snapshot-1',
  projectId: 'project-1',
  externalPostId: 'external-post-1',
  platformId: 'fake-platform',
  capturedAt: '2026-08-30T12:00:00.000Z',
  publishedAt: '2026-08-29T12:00:00.000Z',
  metrics: { plays: 100, likes: 10, comments: 2, saves: 3, shares: 1 },
  source: 'FAKE',
  sourceReference: 'fake:external-post-1:2026-08-30T12:00:00.000Z',
  createdAt: '2026-08-30T12:00:01.000Z',
};

const validReport: ReviewAnalysisReportV1 = {
  schemaVersion: 'REVIEW_ANALYSIS_REPORT_V1',
  id: 'report-1',
  projectId: 'project-1',
  externalPostId: 'external-post-1',
  metricSnapshotIds: ['snapshot-1'],
  summary: 'The post is performing steadily.',
  highlights: [{ title: 'Reach', detail: 'Plays are healthy.' }],
  risks: [{ title: 'Retention', detail: 'Comments lag behind reach.' }],
  recommendations: [{ priority: 'MEDIUM', title: 'Prompt comments', detail: 'Add a question to the caption.' }],
  aiRunId: 'ai-run-1',
  createdAt: '2026-08-30T12:01:00.000Z',
};

test('accepts a complete metric snapshot and rejects unsafe metric values', () => {
  assert.doesNotThrow(() => validateMetricSnapshotV1(validSnapshot));
  assert.throws(() => validateMetricSnapshotV1({ ...validSnapshot, metrics: { ...validSnapshot.metrics, plays: -1 } }), /non-negative integer/);
  assert.throws(() => validateMetricSnapshotV1({ ...validSnapshot, capturedAt: 'not-a-date' }), /capturedAt/);
  assert.throws(() => validateMetricSnapshotV1({ ...validSnapshot, schemaVersion: 'V0' } as unknown as MetricSnapshotV1), /schemaVersion/);
});

test('requires at least one snapshot and bounded structured recommendations', () => {
  assert.doesNotThrow(() => validateReviewAnalysisReportV1(validReport));
  assert.throws(() => validateReviewAnalysisReportV1({ ...validReport, metricSnapshotIds: [] }), /metricSnapshotIds/);
  assert.throws(
    () => validateReviewAnalysisReportV1({ ...validReport, recommendations: [{ priority: 'URGENT' }] } as unknown as ReviewAnalysisReportV1),
    /priority/,
  );
});
