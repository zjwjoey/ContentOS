import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRuntime } from '../../packages/shared/src/worker-runtime.js';
import { createVideoWorker } from '../../workers/video-worker/src/main.js';
import { createPublisherWorker } from '../../workers/publisher-worker/src/main.js';

test('worker runtime starts, registers bounded handlers and shuts down gracefully', async () => {
  const runtime = new WorkerRuntime('video-worker-test');
  runtime.register('video.render', async () => ({ status: 'SUCCEEDED' }));
  await runtime.start();
  assert.equal(runtime.health().status, 'READY');
  assert.deepEqual(runtime.handlerTypes(), ['video.render']);
  await runtime.shutdown('SIGTERM');
  assert.equal(runtime.health().status, 'STOPPED');
});

test('Video Worker stays bounded and Publisher Worker fails closed without composition', async () => {
  const video = createVideoWorker();
  await video.start();
  assert.deepEqual(video.handlerTypes(), ['video.render']);
  assert.throws(() => createPublisherWorker(), /requires explicit Publisher worker dependencies/);
  await video.shutdown('test');
});
