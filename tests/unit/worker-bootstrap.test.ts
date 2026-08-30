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

test('composed Video Worker reconciles leases independently of deliveries and stops on shutdown', async () => {
  let reconciliations = 0;
  let polls = 0;
  const video = createVideoWorker({
    db: {} as never,
    storage: {} as never,
    assets: {} as never,
    video: {} as never,
    jobs: { reconcileExpiredLeases: async () => { reconciliations += 1; return 0; }, listRunnable: async () => { polls += 1; return []; } } as never,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    reconcileIntervalMs: 15,
    pollIntervalMs: 15,
  });
  await video.start();
  await new Promise((resolve) => setTimeout(resolve, 55));
  assert.ok(reconciliations >= 2);
  assert.ok(polls >= 2);
  await video.shutdown('test');
  const stoppedAt = reconciliations;
  const pollsStoppedAt = polls;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reconciliations, stoppedAt);
  assert.equal(polls, pollsStoppedAt);
});

test('Video Worker keeps reconciling while its first consumption pass is still active', async () => {
  let reconciliations = 0;
  let releaseFirstPoll!: () => void;
  const firstPoll = new Promise<void>((resolve) => { releaseFirstPoll = resolve; });
  let polls = 0;
  const video = createVideoWorker({
    db: {} as never,
    storage: {} as never,
    assets: {} as never,
    video: {} as never,
    jobs: {
      reconcileExpiredLeases: async () => { reconciliations += 1; return 0; },
      listRunnable: async () => { polls += 1; if (polls === 1) await firstPoll; return []; },
    } as never,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    reconcileIntervalMs: 15,
    pollIntervalMs: 15,
  });

  const starting = video.start();
  await new Promise((resolve) => setTimeout(resolve, 55));
  assert.ok(reconciliations >= 2);
  releaseFirstPoll();
  await starting;
  await video.shutdown('test');
});
