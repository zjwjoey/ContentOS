import { basename } from 'node:path';
import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';
import { createDigitalHumanJobRunner, type DigitalHumanWorkerDependencies } from './handler.js';
import { AVATAR_LIPSYNC_GENERATE, SPEECH_GENERATE } from './job-types.js';

export function createDigitalHumanWorker(dependencies?: DigitalHumanWorkerDependencies): WorkerRuntime {
  if (!dependencies) throw new Error('Digital Human worker requires explicit dependencies');
  const runtime = new WorkerRuntime('digital-human-worker'); const run = createDigitalHumanJobRunner(dependencies);
  runtime.register(SPEECH_GENERATE, run);
  runtime.register(AVATAR_LIPSYNC_GENERATE, run);
  runtime.register('digital-human.generate', run);
  return runtime;
}

if (basename(process.argv[1] ?? '') === 'main.ts') throw new Error('Digital Human worker composition must be provided by the deployment entrypoint');
