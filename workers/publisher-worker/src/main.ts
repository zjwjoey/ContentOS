import { WorkerRuntime, type JobHandler } from '../../../packages/shared/src/worker-runtime.js';

export function createPublisherWorker(handler: JobHandler = async () => ({ status: 'NO_OP_STAGE_4_BOOTSTRAP' })): WorkerRuntime {
  const runtime = new WorkerRuntime('publisher-worker');
  runtime.register('publisher.publish', handler);
  return runtime;
}

if (process.argv[1]?.endsWith('main.ts')) {
  const worker = createPublisherWorker();
  process.once('SIGINT', () => void worker.shutdown('SIGINT'));
  process.once('SIGTERM', () => void worker.shutdown('SIGTERM'));
  await worker.start();
  console.log(JSON.stringify(worker.health()));
}
