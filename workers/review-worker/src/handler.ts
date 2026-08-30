import type { JobRecord } from '../../../packages/modules/job/src/index.js';
import { ReviewAnalyticsService, REVIEW_COLLECT_METRICS } from '../../../packages/modules/review/src/index.js';
import type { PublisherExternalPostReader } from '../../../packages/modules/review/src/index.js';
import type { ReviewMetricsSource } from '../../../packages/modules/review/src/metrics-source.js';
import type { JobService } from '../../../packages/modules/job/src/index.js';

export interface ReviewWorkerDependencies {
  jobs: JobService;
  analytics: ReviewAnalyticsService;
  posts: PublisherExternalPostReader;
  metricsSource: ReviewMetricsSource;
}

function invalid(message: string): Error { return Object.assign(new Error(message), { code: 'REVIEW_PAYLOAD_INVALID', retryable: false }); }

export function createReviewJobHandler(deps: ReviewWorkerDependencies): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, attemptId, signal) => {
    const payload = job.payload as Record<string, unknown>;
    if (job.type !== REVIEW_COLLECT_METRICS || payload.schemaVersion !== 'REVIEW_METRIC_COLLECTION_JOB_V1' || payload.projectId !== job.projectId || typeof payload.externalPostId !== 'string' || !['FAKE', 'IMPORT'].includes(String(payload.source))) throw invalid('Invalid Review metric collection Job payload');
    const post = await deps.posts.getExternalPost(String(payload.projectId), payload.externalPostId);
    if (!post) throw Object.assign(new Error('ExternalPost not found for project'), { code: 'REVIEW_EXTERNAL_POST_NOT_FOUND', retryable: false });
    signal.throwIfAborted();
    const collected = await deps.metricsSource.collect(post);
    signal.throwIfAborted();
    const result = await deps.jobs.succeedWithCurrentAttempt(job.id, attemptId, async () => {
      const snapshot = await deps.analytics.recordMetricSnapshot({
        projectId: post ? String(payload.projectId) : '',
        externalPostId: String(payload.externalPostId),
        platformId: post.platformId,
        capturedAt: collected.capturedAt,
        publishedAt: collected.publishedAt,
        metrics: collected.metrics,
        source: String(payload.source) as 'FAKE' | 'IMPORT',
        sourceReference: collected.sourceReference,
      });
      return { snapshotId: snapshot.id, externalPostId: snapshot.externalPostId, status: 'RECORDED' };
    });
    return result.executed ? result.value : { status: 'STALE_ATTEMPT' };
  };
}

