import { basename } from 'node:path';
import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';
import { JobRunner, type JobService } from '../../../packages/modules/job/src/index.js';
import { MEDIA_ANALYSIS, MediaIntelligenceService } from '../../../packages/modules/intelligence/src/index.js';
import { createMediaAnalysisJobHandler, type MediaIntelligenceWorkerDependencies } from './handler.js';

export type { MediaAnalysisJobPayload, MediaIntelligenceWorkerDependencies } from './handler.js';

export function createMediaIntelligenceWorker(dependencies: MediaIntelligenceWorkerDependencies): WorkerRuntime {
  const runtime = new WorkerRuntime('media-intelligence-worker-v15');
  const handler = createMediaAnalysisJobHandler(dependencies);
  runtime.register(MEDIA_ANALYSIS, async (invocation) => {
    const jobId = (invocation as { jobId?: unknown } | undefined)?.jobId;
    if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Media intelligence worker invocation requires jobId');
    const job = await dependencies.jobs.get(jobId);
    if (!job) throw new Error('Media intelligence job not found');
    return new JobRunner(dependencies.jobs, 'media-intelligence-worker-v15').run(job.id, handler);
  });
  return runtime;
}

if (basename(process.argv[1] ?? '') === 'main.ts') throw new Error('Media intelligence worker composition must be provided by the deployment entrypoint');
