import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';

export function createVideoWorker(): WorkerRuntime {
  const runtime = new WorkerRuntime('video-worker');
  runtime.register('video.render', async () => ({ status: 'NOT_IMPLEMENTED_STAGE_4_BOOTSTRAP' }));
  return runtime;
}

if (process.argv[1]?.endsWith('main.ts')) {
  const worker = createVideoWorker();
  process.once('SIGINT', () => void worker.shutdown('SIGINT'));
  process.once('SIGTERM', () => void worker.shutdown('SIGTERM'));
  await worker.start();
  console.log(JSON.stringify(worker.health()));
}
