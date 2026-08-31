export type MetricSnapshotSource = 'FAKE' | 'IMPORT';

export interface MetricValuesV1 {
  plays: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  followersDelta?: number;
  completionRate?: number;
  averageWatchTimeSeconds?: number;
}

export interface MetricSnapshotV1 {
  schemaVersion: 'METRIC_SNAPSHOT_V1';
  id: string;
  projectId: string;
  externalPostId: string;
  platformId: string;
  capturedAt: string;
  publishedAt: string | null;
  metrics: MetricValuesV1;
  source: MetricSnapshotSource;
  sourceReference: string;
  createdAt: string;
}

export interface ReviewInsightV1 {
  title: string;
  detail: string;
}

export type ReviewRecommendationPriority = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ReviewRecommendationV1 extends ReviewInsightV1 {
  priority: ReviewRecommendationPriority;
}

export interface ReviewAnalysisReportV1 {
  schemaVersion: 'REVIEW_ANALYSIS_REPORT_V1';
  id: string;
  projectId: string;
  externalPostId: string;
  metricSnapshotIds: string[];
  summary: string;
  highlights: ReviewInsightV1[];
  risks: ReviewInsightV1[];
  recommendations: ReviewRecommendationV1[];
  aiRunId: string;
  createdAt: string;
}

const MAX_STRING_LENGTH = 20_000;
const MAX_ARRAY_LENGTH = 100;

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertBoundedString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty`);
  if (value.length > MAX_STRING_LENGTH) throw new Error(`${label} exceeds maximum length`);
}

function assertTimestamp(value: unknown, label: string, nullable = false): asserts value is string | null {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
}

function assertMetricValues(value: unknown): asserts value is MetricValuesV1 {
  assertRecord(value, 'metrics');
  for (const key of ['plays', 'likes', 'comments', 'saves', 'shares'] as const) {
    const metric = value[key];
    if (typeof metric !== 'number' || !Number.isSafeInteger(metric) || metric < 0) {
      throw new Error(`metrics.${key} must be a non-negative integer`);
    }
  }
  if (value.followersDelta !== undefined && (!Number.isSafeInteger(value.followersDelta))) throw new Error('metrics.followersDelta must be an integer');
  if (value.completionRate !== undefined && (typeof value.completionRate !== 'number' || value.completionRate < 0 || value.completionRate > 1)) throw new Error('metrics.completionRate must be between 0 and 1');
  if (value.averageWatchTimeSeconds !== undefined && (typeof value.averageWatchTimeSeconds !== 'number' || value.averageWatchTimeSeconds < 0)) throw new Error('metrics.averageWatchTimeSeconds must be non-negative');
}

function assertInsight(value: unknown, label: string, recommendation = false): void {
  assertRecord(value, label);
  if (recommendation && !['HIGH', 'MEDIUM', 'LOW'].includes(String(value.priority))) {
    throw new Error(`${label}.priority is invalid; expected HIGH|MEDIUM|LOW`);
  }
  assertBoundedString(value.title, `${label}.title`);
  assertBoundedString(value.detail, `${label}.detail`);
}

function assertBoundedArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) throw new Error(`${label} must contain at most ${MAX_ARRAY_LENGTH} entries`);
}

export function validateMetricSnapshotV1(snapshot: MetricSnapshotV1): void {
  assertRecord(snapshot, 'snapshot');
  if (snapshot.schemaVersion !== 'METRIC_SNAPSHOT_V1') throw new Error('Unsupported metric snapshot schemaVersion');
  for (const key of ['id', 'projectId', 'externalPostId', 'platformId', 'sourceReference', 'createdAt'] as const) {
    assertBoundedString(snapshot[key], key);
  }
  assertTimestamp(snapshot.capturedAt, 'capturedAt');
  assertTimestamp(snapshot.publishedAt, 'publishedAt', true);
  if (!['FAKE', 'IMPORT'].includes(String(snapshot.source))) throw new Error('source is invalid');
  assertMetricValues(snapshot.metrics);
}

export function validateReviewAnalysisReportV1(report: ReviewAnalysisReportV1): void {
  assertRecord(report, 'report');
  if (report.schemaVersion !== 'REVIEW_ANALYSIS_REPORT_V1') throw new Error('Unsupported review analysis schemaVersion');
  for (const key of ['id', 'projectId', 'externalPostId', 'summary', 'aiRunId', 'createdAt'] as const) {
    assertBoundedString(report[key], key);
  }
  assertTimestamp(report.createdAt, 'createdAt');
  assertBoundedArray(report.metricSnapshotIds, 'metricSnapshotIds');
  if (report.metricSnapshotIds.length === 0) throw new Error('metricSnapshotIds must contain at least one snapshot');
  for (const id of report.metricSnapshotIds) assertBoundedString(id, 'metricSnapshotIds entry');
  for (const [key, recommendation] of [['highlights', false], ['risks', false], ['recommendations', true]] as const) {
    assertBoundedArray(report[key], key);
    report[key].forEach((item, index) => assertInsight(item, `${key}[${index}]`, recommendation));
  }
}
