import test from 'node:test';
import assert from 'node:assert/strict';
import { createDigitalHumanDevRunner } from '../../workers/digital-human-worker/src/dev-main.js';
import { createDigitalHumanWorker } from '../../workers/digital-human-worker/src/main.js';
import { createDigitalHumanJobHandler } from '../../workers/digital-human-worker/src/handler.js';

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

test('Digital Human worker cancels an external avatar task when its job is aborted', async () => {
  const cancelledTasks: string[] = [];
  const cancelledGenerations: string[] = [];
  const deps = {
    digitalHuman: {
      getAvatarGeneration: async () => ({ id: 'generation-1', status: 'WAITING_EXTERNAL', externalTaskId: 'remote-1', projectId: 'project-1', avatarClipId: 'clip-1', speechAssetId: 'audio-1', avatarProfileId: 'profile-1', model: null, modelVersion: null, jobId: 'job-1', outputAssetId: null, durationMs: null, costAmount: null, costCurrency: null, requestHash: 'hash', provenance: { parameters: {} }, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      markAvatarRunning: async () => undefined,
      getAvatarClip: async () => ({ id: 'clip-1', projectId: 'project-1', name: 'clip', assetId: 'video-1', status: 'READY', metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      cancelAvatar: async (id: string) => { cancelledGenerations.push(id); },
    },
    assets: {
      getProjectAsset: async (_projectId: string, id: string) => id === 'video-1' ? { id, projectId: 'project-1', kind: 'VIDEO', lifecycle: 'READY', storageKey: 'video.mp4' } : { id, projectId: 'project-1', kind: 'AUDIO', lifecycle: 'READY', storageKey: 'audio.wav' },
    },
    staging: { stageAsset: async (id: string) => ({ assetId: id, publicUrl: `https://provider.test/${id}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
    avatarProvider: {
      getTask: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { externalTaskId: 'remote-1', providerId: 'hzagent', status: 'QUEUED' }; },
      cancelTask: async (id: string) => { cancelledTasks.push(id); },
    },
  } as never;
  const job = { id: 'job-1', projectId: 'project-1', workspaceId: null, type: 'AVATAR_LIPSYNC_GENERATE', state: 'RUNNING', payload: { schemaVersion: 'DIGITAL_HUMAN_JOB_PAYLOAD_V1', kind: 'AVATAR', generationId: 'generation-1', projectId: 'project-1', correlationId: 'corr-1' }, result: null, error: null, attemptCount: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, progress: null } as never;
  const controller = new AbortController();
  const running = createDigitalHumanJobHandler(deps)(job, 'attempt-1', controller.signal);
  setTimeout(() => controller.abort(), 1);
  await assert.rejects(running);
  assert.deepEqual(cancelledTasks, ['remote-1']);
  assert.deepEqual(cancelledGenerations, ['generation-1']);
});
