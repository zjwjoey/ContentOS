import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';
import { DIRECTOR_GENERATE_SCRIPT, DIRECTOR_GENERATE_STORYBOARD } from '../../../packages/modules/director/src/director-job-service.js';
import { createDirectorJobHandler, type DirectorWorkerDependencies } from './handler.js';

export type { DirectorWorkerDependencies } from './handler.js';

export function createDirectorWorker(dependencies?: DirectorWorkerDependencies): WorkerRuntime {
  if (!dependencies) throw new Error('Director worker requires explicit Director worker dependencies');
  const runtime = new WorkerRuntime('director-worker');
  runtime.register(DIRECTOR_GENERATE_SCRIPT, createDirectorJobHandler(DIRECTOR_GENERATE_SCRIPT, dependencies));
  runtime.register(DIRECTOR_GENERATE_STORYBOARD, createDirectorJobHandler(DIRECTOR_GENERATE_STORYBOARD, dependencies));
  return runtime;
}

if (process.argv[1]?.endsWith('main.ts')) throw new Error('Director worker composition must be provided by the deployment entrypoint');
