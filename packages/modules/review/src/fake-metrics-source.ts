import type { PublisherExternalPost } from '../../../contracts/src/index.js';
import type { CollectedReviewMetrics, ReviewMetricsSource } from './metrics-source.js';

export type FakeMetricsOutcome = 'SUCCESS' | 'UNAVAILABLE' | 'MALFORMED';

function stableNumber(input: string, offset: number, range: number): number {
  let hash = offset;
  for (const char of input) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % range;
}

export class FakeMetricsSource implements ReviewMetricsSource {
  constructor(private readonly outcome: FakeMetricsOutcome = 'SUCCESS') {}

  async collect(post: PublisherExternalPost): Promise<CollectedReviewMetrics> {
    if (this.outcome === 'UNAVAILABLE') throw Object.assign(new Error('Fake metrics source unavailable'), { code: 'METRICS_SOURCE_UNAVAILABLE', retryable: true });
    if (this.outcome === 'MALFORMED') throw Object.assign(new Error('Fake metrics source returned malformed data'), { code: 'METRICS_SOURCE_MALFORMED', retryable: false });
    const capturedAt = new Date().toISOString();
    const seed = `${post.id}:${post.externalPostId}`;
    const plays = 1_000 + stableNumber(seed, 17, 90_000);
    return {
      capturedAt,
      publishedAt: post.firstObservedAt,
      metrics: { plays, likes: Math.floor(plays * 0.08), comments: Math.floor(plays * 0.01), saves: Math.floor(plays * 0.02), shares: Math.floor(plays * 0.005) },
      sourceReference: `fake-metrics:${post.id}:${capturedAt}`,
    };
  }
}

