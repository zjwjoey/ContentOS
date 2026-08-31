import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';
import { BENCHMARK_ANALYZE } from '../../../packages/modules/benchmark/src/index.js';
import { createBenchmarkJobHandler, type BenchmarkWorkerDependencies } from './handler.js';
import { JobRunner } from '../../../packages/modules/job/src/index.js';
import { basename } from 'node:path';
export type { BenchmarkWorkerDependencies } from './handler.js';
export function createBenchmarkWorker(dependencies: BenchmarkWorkerDependencies): WorkerRuntime {
  const runtime = new WorkerRuntime('benchmark-worker');
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
