import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';
import { JobRunner, JobService } from '../../../packages/modules/job/src/index.js';
import { REVIEW_COLLECT_METRICS, REVIEW_GENERATE_ANALYSIS } from '../../../packages/modules/review/src/index.js';
import type { PublisherExternalPostReader } from '../../../packages/modules/review/src/index.js';
import type { ReviewMetricsSource } from '../../../packages/modules/review/src/metrics-source.js';
import { createReviewJobHandler, type ReviewWorkerDependencies } from './handler.js';
import { basename } from 'node:path';

export type { ReviewWorkerDependencies } from './handler.js';

export interface ReviewWorkerOptions extends ReviewWorkerDependencies {
  workerId?: string;
  concurrency?: number;
}

export function createReviewWorker(options: ReviewWorkerOptions): WorkerRuntime {
  const runner = new JobRunner(options.jobs, options.workerId || 'review-worker');
  const handler = createReviewJobHandler(options);
  const runtime = new WorkerRuntime(options.workerId || 'review-worker');
  const register = (type: string) =>
    runtime.register(type, (payload) => {
      const jobId = payload && typeof payload === 'object' ? (payload as { jobId?: unknown }).jobId : undefined;
      if (typeof jobId !== 'string' || !jobId) throw new Error('Review delivery requires jobId');
      return runner.run(jobId, handler);
    });
  register(REVIEW_COLLECT_METRICS);
  register(REVIEW_GENERATE_ANALYSIS);
  return runtime;
}

if (basename(process.argv[1] ?? '') === 'main.ts') throw new Error('Review worker composition must be provided by the deployment entrypoint');
