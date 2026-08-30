import type { PublisherExternalPost } from '../../../contracts/src/index.js';

export interface CollectedReviewMetrics {
  capturedAt: string;
  publishedAt: string | null;
  metrics: { plays: number; likes: number; comments: number; saves: number; shares: number };
  sourceReference: string;
}

export interface ReviewMetricsSource {
  collect(post: PublisherExternalPost): Promise<CollectedReviewMetrics>;
}
