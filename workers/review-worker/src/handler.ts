import type { JobRecord } from '../../../packages/modules/job/src/index.js';
import { ReviewAnalyticsService, REVIEW_COLLECT_METRICS, REVIEW_GENERATE_ANALYSIS } from '../../../packages/modules/review/src/index.js';
import type { PublisherExternalPostReader } from '../../../packages/modules/review/src/index.js';
import type { ReviewMetricsSource } from '../../../packages/modules/review/src/metrics-source.js';
import type { JobService } from '../../../packages/modules/job/src/index.js';
import type { AIService } from '../../../packages/modules/ai/src/ai-service.js';
import { validateReviewAnalysisReportV1 } from '../../../packages/contracts/src/index.js';
import { randomUUID } from 'node:crypto';

export interface ReviewWorkerDependencies {
  jobs: JobService;
  analytics: ReviewAnalyticsService;
  posts: PublisherExternalPostReader;
  metricsSource: ReviewMetricsSource;
  ai?: AIService;
}

function invalid(message: string): Error { return Object.assign(new Error(message), { code: 'REVIEW_PAYLOAD_INVALID', retryable: false }); }

export function createReviewJobHandler(deps: ReviewWorkerDependencies): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, attemptId, signal) => {
    const payload = job.payload as Record<string, unknown>;
    if (job.type === REVIEW_GENERATE_ANALYSIS) {
      if (!deps.ai || payload.schemaVersion !== 'REVIEW_ANALYSIS_JOB_V1' || payload.projectId !== job.projectId || typeof payload.externalPostId !== 'string' || !Array.isArray(payload.metricSnapshotIds) || payload.metricSnapshotIds.length === 0) throw invalid('Invalid Review analysis Job payload');
      const snapshotIds = payload.metricSnapshotIds.filter((id): id is string => typeof id === 'string');
      if (snapshotIds.length !== payload.metricSnapshotIds.length) throw invalid('Invalid Review analysis snapshot IDs');
      const snapshots = await deps.analytics.getMetricSnapshots(String(payload.projectId), String(payload.externalPostId), snapshotIds);
      if (snapshots.length !== snapshotIds.length) throw Object.assign(new Error('Metric snapshots not found for project/post'), { code: 'REVIEW_SNAPSHOT_NOT_FOUND', retryable: false });
      signal.throwIfAborted();
      const latest = snapshots.at(-1)!;
      const aiResult = await deps.ai.generateStructured({
        projectId: String(payload.projectId), jobId: job.id, attemptId, correlationId: String(payload.correlationId || ''), operation: 'REVIEW_GENERATE_ANALYSIS', promptKey: 'review.analysis.v1',
        variables: { platformId: latest.platformId, publishedAt: latest.publishedAt || latest.capturedAt, metrics: JSON.stringify(latest.metrics), history: JSON.stringify(snapshots.map((snapshot) => ({ capturedAt: snapshot.capturedAt, metrics: snapshot.metrics }))) },
      }, (value) => {
        if (!value || typeof value !== 'object') throw new Error('Review analysis output must be an object');
        const candidate = value as Record<string, unknown>;
        validateReviewAnalysisReportV1({ schemaVersion: 'REVIEW_ANALYSIS_REPORT_V1', id: 'validation', projectId: String(payload.projectId), externalPostId: String(payload.externalPostId), metricSnapshotIds: snapshotIds, summary: String(candidate.summary || ''), highlights: candidate.highlights as never, risks: candidate.risks as never, recommendations: candidate.recommendations as never, aiRunId: 'validation', createdAt: new Date().toISOString() });
        return candidate;
      });
      signal.throwIfAborted();
      const result = await deps.jobs.succeedWithCurrentAttempt(job.id, attemptId, async (scope) => {
        const report = await deps.analytics.recordAnalysisReport({ schemaVersion: 'REVIEW_ANALYSIS_REPORT_V1', id: `review-report-${randomUUID()}`, projectId: String(payload.projectId), externalPostId: String(payload.externalPostId), metricSnapshotIds: snapshotIds, summary: String((aiResult.output as Record<string, unknown>).summary), highlights: (aiResult.output as Record<string, unknown>).highlights as never, risks: (aiResult.output as Record<string, unknown>).risks as never, recommendations: (aiResult.output as Record<string, unknown>).recommendations as never, aiRunId: aiResult.aiRunId, createdAt: new Date().toISOString() }, scope);
        return { reportId: report.id, externalPostId: report.externalPostId, status: 'RECORDED' };
      });
      return result.executed ? result.value : { status: 'STALE_ATTEMPT' };
    }
    if (job.type !== REVIEW_COLLECT_METRICS || payload.schemaVersion !== 'REVIEW_METRIC_COLLECTION_JOB_V1' || payload.projectId !== job.projectId || typeof payload.externalPostId !== 'string' || !['FAKE', 'IMPORT'].includes(String(payload.source))) throw invalid('Invalid Review metric collection Job payload');
    const post = await deps.posts.getExternalPost(String(payload.projectId), payload.externalPostId);
    if (!post) throw Object.assign(new Error('ExternalPost not found for project'), { code: 'REVIEW_EXTERNAL_POST_NOT_FOUND', retryable: false });
    signal.throwIfAborted();
    const collected = await deps.metricsSource.collect(post);
    signal.throwIfAborted();
    const result = await deps.jobs.succeedWithCurrentAttempt(job.id, attemptId, async (scope) => {
      const snapshot = await deps.analytics.recordMetricSnapshot({
        projectId: post ? String(payload.projectId) : '',
        externalPostId: String(payload.externalPostId),
        platformId: post.platformId,
        capturedAt: collected.capturedAt,
        publishedAt: collected.publishedAt,
        metrics: collected.metrics,
        source: String(payload.source) as 'FAKE' | 'IMPORT',
        sourceReference: collected.sourceReference,
      }, scope);
      return { snapshotId: snapshot.id, externalPostId: snapshot.externalPostId, status: 'RECORDED' };
    });
    return result.executed ? result.value : { status: 'STALE_ATTEMPT' };
  };
}
