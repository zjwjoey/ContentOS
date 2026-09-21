import test from 'node:test';
import assert from 'node:assert/strict';
import { createDigitalHumanDevRunner } from '../../workers/digital-human-worker/src/dev-main.js';
import { createDigitalHumanWorker } from '../../workers/digital-human-worker/src/main.js';

const fakeDependencies = (jobs: { listRunnable: () => Promise<never[]>; reconcileExpiredLeases: () => Promise<number> }) => ({ jobs, digitalHuman: {}, assets: {}, assetService: {}, storage: {}, speechProvider: {}, avatarProvider: {}, staging: {} } as never);

test('Digital Human Worker registers both durable job types and requires composition', async () => {
  assert.throws(() => createDigitalHumanWorker(), /requires explicit/);
  const worker = createDigitalHumanWorker(fakeDependencies({ listRunnable: async () => [], reconcileExpiredLeases: async () => 0 }));
  assert.deepEqual(worker.handlerTypes(), ['AVATAR_LIPSYNC_GENERATE', 'SPEECH_GENERATE', 'digital-human.generate']);
  await worker.start(); await worker.shutdown('test');
});

test('Digital Human dev runner polls and recovers on independent timers', async () => {
  let polls = 0; let recoveries = 0;
  const runner = createDigitalHumanDevRunner(fakeDependencies({ listRunnable: async () => { polls += 1; return []; }, reconcileExpiredLeases: async () => { recoveries += 1; return 0; } }), { pollIntervalMs: 10, recoveryIntervalMs: 10 });
  await runner.start(); await new Promise((resolve) => setTimeout(resolve, 35)); await runner.stop('test');
  assert.ok(polls >= 2); assert.ok(recoveries >= 2);
  const stoppedPolls = polls; const stoppedRecoveries = recoveries;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(polls, stoppedPolls); assert.equal(recoveries, stoppedRecoveries);
});
