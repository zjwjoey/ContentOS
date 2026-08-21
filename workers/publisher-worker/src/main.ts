import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';

export function createPublisherWorker(): WorkerRuntime {
  const runtime = new WorkerRuntime('publisher-worker');
  runtime.register('publisher.publish', async () => ({ status: 'NO_OP_STAGE_4_BOOTSTRAP' }));
  return runtime;
}

if (process.argv[1]?.endsWith('main.ts')) {
  const worker = createPublisherWorker();
  process.once('SIGINT', () => void worker.shutdown('SIGINT'));
  process.once('SIGTERM', () => void worker.shutdown('SIGTERM'));
  await worker.start();
  console.log(JSON.stringify(worker.health()));
}
