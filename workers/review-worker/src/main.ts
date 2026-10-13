import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';
import { JobRunner, JobService, type JobLeaseRecoveryHandler } from '../../../packages/modules/job/src/index.js';
import { REVIEW_COLLECT_METRICS, REVIEW_GENERATE_ANALYSIS } from '../../../packages/modules/review/src/index.js';
import type { PublisherExternalPostReader } from '../../../packages/modules/review/src/index.js';
import type { ReviewMetricsSource } from '../../../packages/modules/review/src/metrics-source.js';
import { createReviewJobHandler, type ReviewWorkerDependencies } from './handler.js';
import { basename } from 'node:path';

export type { ReviewWorkerDependencies } from './handler.js';

export interface ReviewWorkerOptions extends ReviewWorkerDependencies { workerId?: string; concurrency?: number; }


export const reviewLeaseRecoveryHandler: JobLeaseRecoveryHandler = async (job) => [REVIEW_COLLECT_METRICS, REVIEW_GENERATE_ANALYSIS].includes(job.type); // This owner has no durable RUNNING record to settle.

class ReviewWorkerRuntime extends WorkerRuntime {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  constructor(workerId: string, private readonly jobs: JobService) { super(workerId); }
  private reconcile(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.jobs.reconcileExpiredLeases(new Date(), undefined, { types: [REVIEW_COLLECT_METRICS, REVIEW_GENERATE_ANALYSIS], recover: reviewLeaseRecoveryHandler }).then(() => undefined).catch(() => { console.error(JSON.stringify({ level: 'error', event: 'review.lease_recovery_failed', code: 'LEASE_RECOVERY_FAILED' })); }).finally(() => { this.active = null; });
    return this.active;
  }
  override async start(): Promise<void> { await this.reconcile(); await super.start(); this.timer = setInterval(() => { void this.reconcile(); }, 5_000); this.timer.unref(); }
  override async shutdown(signal: string): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; if (this.active) await this.active; await super.shutdown(signal); }
}

export function createReviewWorker(options: ReviewWorkerOptions): WorkerRuntime {
  const runner = new JobRunner(options.jobs, options.workerId || 'review-worker');
  const handler = createReviewJobHandler(options);
  const runtime = new ReviewWorkerRuntime(options.workerId || 'review-worker', options.jobs);
  const register = (type: string) => runtime.register(type, (payload) => {
    const jobId = payload && typeof payload === 'object' ? (payload as { jobId?: unknown }).jobId : undefined;
    if (typeof jobId !== 'string' || !jobId) throw new Error('Review delivery requires jobId');
    return runner.run(jobId, handler);
  });
  register(REVIEW_COLLECT_METRICS);
  register(REVIEW_GENERATE_ANALYSIS);
  return runtime;
}

if (basename(process.argv[1] ?? '') === 'main.ts') throw new Error('Review worker composition must be provided by the deployment entrypoint');
