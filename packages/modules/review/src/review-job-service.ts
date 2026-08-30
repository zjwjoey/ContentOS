import { randomUUID } from 'node:crypto';
import type { JobRecord, JobService } from '../../job/src/index.js';

export const REVIEW_COLLECT_METRICS = 'REVIEW_COLLECT_METRICS';
export const REVIEW_GENERATE_ANALYSIS = 'REVIEW_GENERATE_ANALYSIS';
export const REVIEW_JOB_MAX_ATTEMPTS = 3;

export interface ReviewMetricCollectionJobPayload {
  schemaVersion: 'REVIEW_METRIC_COLLECTION_JOB_V1';
  projectId: string;
  externalPostId: string;
  source: 'FAKE' | 'IMPORT';
  idempotencyKey: string;
  correlationId: string;
}

export interface ReviewAnalysisJobPayload {
  schemaVersion: 'REVIEW_ANALYSIS_JOB_V1';
  projectId: string;
  externalPostId: string;
  metricSnapshotIds: string[];
  idempotencyKey: string;
  correlationId: string;
}

export interface PublisherExternalPostReader {
  getExternalPost(
    projectId: string,
    externalPostId: string,
  ): Promise<{
    id: string;
    requestId: string;
    accountId: string;
    platformId: string;
    externalPostId: string;
    externalUrl: string | null;
    firstObservedAt: string;
    lastReconciledAt: string | null;
  } | null>;
}

function samePayload(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export class ReviewJobService {
  constructor(
    private readonly jobs: JobService,
    private readonly posts: PublisherExternalPostReader,
  ) {}

  async createMetricCollectionJob(input: Omit<ReviewMetricCollectionJobPayload, 'schemaVersion'>): Promise<JobRecord> {
    const post = await this.posts.getExternalPost(input.projectId, input.externalPostId);
    if (!post) throw new Error('ExternalPost not found for project');
    const payload: ReviewMetricCollectionJobPayload = { schemaVersion: 'REVIEW_METRIC_COLLECTION_JOB_V1', ...input };
    return this.createIdempotent({
      type: REVIEW_COLLECT_METRICS,
      projectId: input.projectId,
      payload,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async createAnalysisJob(input: Omit<ReviewAnalysisJobPayload, 'schemaVersion'>): Promise<JobRecord> {
    if (input.metricSnapshotIds.length === 0) throw new Error('metricSnapshotIds must contain at least one snapshot');
    const post = await this.posts.getExternalPost(input.projectId, input.externalPostId);
    if (!post) throw new Error('ExternalPost not found for project');
    const payload: ReviewAnalysisJobPayload = { schemaVersion: 'REVIEW_ANALYSIS_JOB_V1', ...input };
    return this.createIdempotent({
      type: REVIEW_GENERATE_ANALYSIS,
      projectId: input.projectId,
      payload,
      idempotencyKey: input.idempotencyKey,
    });
  }

  private async createIdempotent(input: { type: string; projectId: string; payload: unknown; idempotencyKey: string }): Promise<JobRecord> {
    const existing = await this.jobs.getByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.type !== input.type || existing.projectId !== input.projectId || !samePayload(existing.payload, input.payload)) {
        throw new Error('Idempotency key conflict: input does not match existing Review Job');
      }
      return existing;
    }
    try {
      return await this.jobs.createIdempotent({
        id: `review-job-${randomUUID()}`,
        type: input.type,
        projectId: input.projectId,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: REVIEW_JOB_MAX_ATTEMPTS,
      });
    } catch (error) {
      const raced = await this.jobs.getByIdempotencyKey(input.idempotencyKey);
      if (raced && raced.type === input.type && raced.projectId === input.projectId && samePayload(raced.payload, input.payload)) return raced;
      throw error;
    }
  }
}
