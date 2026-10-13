import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';
import { BENCHMARK_ANALYZE } from '../../../packages/modules/benchmark/src/index.js';
import { createBenchmarkJobHandler, type BenchmarkWorkerDependencies } from './handler.js';
import { JobRunner, type JobService, type JobLeaseRecoveryHandler } from '../../../packages/modules/job/src/index.js';
import { basename } from 'node:path';
export type { BenchmarkWorkerDependencies } from './handler.js';

export const benchmarkLeaseRecoveryHandler: JobLeaseRecoveryHandler = async (job) => [BENCHMARK_ANALYZE].includes(job.type); // This owner has no durable RUNNING record to settle.

class BenchmarkWorkerRuntime extends WorkerRuntime {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  constructor(workerId: string, private readonly jobs: JobService) { super(workerId); }
  private reconcile(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.jobs.reconcileExpiredLeases(new Date(), undefined, { types: [BENCHMARK_ANALYZE], recover: benchmarkLeaseRecoveryHandler }).then(() => undefined).catch(() => { console.error(JSON.stringify({ level: 'error', event: 'benchmark.lease_recovery_failed', code: 'LEASE_RECOVERY_FAILED' })); }).finally(() => { this.active = null; });
    return this.active;
  }
  override async start(): Promise<void> { await this.reconcile(); await super.start(); this.timer = setInterval(() => { void this.reconcile(); }, 5_000); this.timer.unref(); }
  override async shutdown(signal: string): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; if (this.active) await this.active; await super.shutdown(signal); }
}

export function createBenchmarkWorker(dependencies: BenchmarkWorkerDependencies): WorkerRuntime {
  const runtime = new BenchmarkWorkerRuntime('benchmark-worker', dependencies.jobs);
  const handler = createBenchmarkJobHandler(dependencies);
  runtime.register(BENCHMARK_ANALYZE, async (invocation) => {
    const jobId = (invocation as { jobId?: unknown } | undefined)?.jobId;
    if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Benchmark worker invocation requires jobId');
    const job = await dependencies.jobs.get(jobId);
    if (!job) throw new Error('Benchmark job not found');
    return new JobRunner(dependencies.jobs, 'benchmark-worker').run(job.id, (record, attemptId, signal) => handler(record, attemptId, signal));
  });
  return runtime;
}
if (basename(process.argv[1] ?? '') === 'main.ts') throw new Error('Benchmark worker composition must be provided by the deployment entrypoint');
