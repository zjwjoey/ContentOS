import test from 'node:test';
import assert from 'node:assert/strict';
import { createDigitalHumanDevRunner } from '../../workers/digital-human-worker/src/dev-main.js';
import { createDigitalHumanWorker } from '../../workers/digital-human-worker/src/main.js';
import { createDigitalHumanJobHandler, createDigitalHumanLeaseCancellationHandler } from '../../workers/digital-human-worker/src/handler.js';

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

test('Digital Human dev runner waits for an in-flight poll before shutdown', async () => {
  let calls = 0; let pollFinished = false;
  const runner = createDigitalHumanDevRunner(fakeDependencies({ listRunnable: async () => { calls += 1; if (calls > 1) await new Promise((resolve) => setTimeout(resolve, 30)); pollFinished = true; return []; }, reconcileExpiredLeases: async () => 0 }), { pollIntervalMs: 10_000, recoveryIntervalMs: 10_000 });
  await runner.start(); pollFinished = false; const pending = runner.pollOnce(); await new Promise((resolve) => setTimeout(resolve, 5)); let stopFinished = false; const stopping = runner.stop('SIGTERM').then(() => { stopFinished = true; }); await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(stopFinished, false); assert.equal(pollFinished, false); await pending; await stopping; assert.equal(stopFinished, true); assert.equal(pollFinished, true);
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
      getProjectAsset: async (_projectId: string, id: string) => id === 'video-1' ? { id, projectId: 'project-1', kind: 'VIDEO', lifecycle: 'READY', storageKey: 'video.mp4', metadata: { durationMs: 2_000, format: 'mp4' } } : { id, projectId: 'project-1', kind: 'AUDIO', lifecycle: 'READY', storageKey: 'audio.wav', metadata: { durationMs: 2_000, format: 'wav' } },
    },
    staging: { stageAsset: async (id: string) => ({ assetId: id, publicUrl: `https://provider.test/${id}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
    avatarProvider: {
      getCapabilities: async () => ({ providerId: 'hzagent', local: false, videoToVideo: true, imageToVideo: false, requiresPublicUrl: true, supportedFormats: ['mp4'] }),
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

test('Digital Human lease recovery cancels a remote Avatar task after worker loss', async () => {
  const cancelledTasks: string[] = []; const cancelledGenerations: string[] = [];
  const handler = createDigitalHumanLeaseCancellationHandler({
    digitalHuman: {
      getAvatarGeneration: async () => ({ id: 'generation-recovery', externalTaskId: 'remote-recovery' }),
      cancelAvatar: async (id: string) => { cancelledGenerations.push(id); },
    },
    avatarProvider: { cancelTask: async (id: string) => { cancelledTasks.push(id); } },
  } as never);
  const result = await handler({ type: 'AVATAR_LIPSYNC_GENERATE', projectId: 'project-1', payload: { kind: 'AVATAR', projectId: 'project-1', generationId: 'generation-recovery' } } as never, {} as never);
  assert.equal(result, true); assert.deepEqual(cancelledTasks, ['remote-recovery']); assert.deepEqual(cancelledGenerations, ['generation-recovery']);
});

test('Digital Human worker resubmits only after an old external task is terminal', async () => {
  let submitted = 0;
  let waiting = 0;
  const deps = {
    digitalHuman: {
      getAvatarGeneration: async () => ({ id: 'generation-2', status: 'PENDING', externalTaskId: 'remote-old', projectId: 'project-1', avatarClipId: 'clip-1', speechAssetId: 'audio-1', avatarProfileId: 'profile-1', model: null, modelVersion: null, jobId: 'job-2', outputAssetId: null, durationMs: null, costAmount: null, costCurrency: null, requestHash: 'hash', provenance: { parameters: {} }, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      markAvatarRunning: async () => undefined,
      getAvatarClip: async () => ({ id: 'clip-1', projectId: 'project-1', name: 'clip', assetId: 'video-1', status: 'READY', metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      replaceAvatarWaiting: async () => { waiting += 1; },
    },
    assets: {
      getProjectAsset: async (_projectId: string, id: string) => id === 'video-1' ? { id, projectId: 'project-1', kind: 'VIDEO', lifecycle: 'READY', storageKey: 'video.mp4', metadata: { durationMs: 2_000, format: 'mp4' } } : { id, projectId: 'project-1', kind: 'AUDIO', lifecycle: 'READY', storageKey: 'audio.wav', metadata: { durationMs: 2_000, format: 'wav' } },
    },
    staging: { stageAsset: async (id: string) => ({ assetId: id, publicUrl: `https://provider.test/${id}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
    avatarProvider: {
      getCapabilities: async () => ({ providerId: 'hzagent', local: false, videoToVideo: true, imageToVideo: false, requiresPublicUrl: true, supportedFormats: ['mp4'] }),
      getTask: async () => ({ externalTaskId: 'remote-old', providerId: 'hzagent', status: 'FAILED', errorCode: 'REMOTE_FAILED' }),
      submitLipSync: async () => { submitted += 1; return { externalTaskId: 'remote-new', providerId: 'hzagent', status: 'QUEUED' }; },
    },
  } as never;
  const job = { id: 'job-2', projectId: 'project-1', workspaceId: null, type: 'AVATAR_LIPSYNC_GENERATE', state: 'RUNNING', payload: { schemaVersion: 'DIGITAL_HUMAN_JOB_PAYLOAD_V1', kind: 'AVATAR', generationId: 'generation-2', projectId: 'project-1', correlationId: 'corr-2' }, result: null, error: null, attemptCount: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, progress: null } as never;
  await assert.rejects(createDigitalHumanJobHandler(deps)(job, 'attempt-2', new AbortController().signal), /still running/);
  assert.equal(submitted, 1);
  assert.equal(waiting, 1);
});

test('Digital Human worker records Speech preflight failures on the Generation', async () => {
  const failures: Array<{ id: string; code: string }> = [];
  const deps = {
    digitalHuman: {
      getSpeechGeneration: async () => ({ id: 'generation-speech-preflight', status: 'PENDING', outputAssetId: null }),
      markSpeechRunning: async () => undefined,
      getVoiceProfile: async () => null,
      failSpeech: async (id: string, error: { code: string }) => { failures.push({ id, code: error.code }); },
    },
  } as never;
  const job = { id: 'job-speech-preflight', projectId: 'project-1', state: 'RUNNING', payload: { schemaVersion: 'DIGITAL_HUMAN_JOB_PAYLOAD_V1', kind: 'SPEECH', generationId: 'generation-speech-preflight', projectId: 'project-1', correlationId: 'corr-preflight' } } as never;
  await assert.rejects(createDigitalHumanJobHandler(deps)(job, 'attempt-speech-preflight', new AbortController().signal), /Voice Profile not found/);
  assert.deepEqual(failures, [{ id: 'generation-speech-preflight', code: 'SPEECH_GENERATION_FAILED' }]);
});

test('Digital Human worker prefers probed Speech Asset duration for completion', async () => {
  let completedDuration = 0; let providerDuration = 0;
  const deps = {
    digitalHuman: {
      getSpeechGeneration: async () => ({ id: 'generation-speech-duration', status: 'PENDING', voiceProfileId: 'voice-1', text: '测试', textHash: 'text-hash', parameters: { language: 'zh', speed: 1, emotion: 'natural' }, outputAssetId: null }),
      markSpeechRunning: async () => undefined,
      getVoiceProfile: async () => ({ id: 'voice-1', referenceAssetId: null, language: 'zh', defaultSpeed: 1, defaultEmotion: 'natural' }),
      completeSpeech: async (_id: string, input: { durationMs: number; provenance: { providerDurationMs: number } }) => { completedDuration = input.durationMs; providerDuration = input.provenance.providerDurationMs; return true; },
    },
    assets: { getProjectAsset: async () => ({ id: 'audio-output', projectId: 'project-1', kind: 'AUDIO', lifecycle: 'READY', storageKey: 'audio.wav', checksum: 'checksum', metadata: { durationMs: 1_234, format: 'wav' } }) },
    assetService: { importFile: async () => ({ id: 'audio-output' }) },
    storage: { objectPath: (value: string) => value },
    speechProvider: { generateSpeech: async () => ({ providerId: 'indextts25', model: 'indextts-2.5', modelVersion: '2.5', outputPath: 'audio.wav', durationMs: 2_000, latencyMs: 10, provenance: {} }) },
  } as never;
  const job = { id: 'job-speech-duration', projectId: 'project-1', state: 'RUNNING', payload: { schemaVersion: 'DIGITAL_HUMAN_JOB_PAYLOAD_V1', kind: 'SPEECH', generationId: 'generation-speech-duration', projectId: 'project-1', correlationId: 'corr-duration' } } as never;
  const result = await createDigitalHumanJobHandler(deps)(job, 'attempt-speech-duration', new AbortController().signal);
  assert.deepEqual(result, { generationId: 'generation-speech-duration', outputAssetId: 'audio-output', state: 'SUCCEEDED' }); assert.equal(completedDuration, 1_234); assert.equal(providerDuration, 2_000);
});

test('Digital Human worker records Avatar preflight failures on the Generation', async () => {
  const failures: Array<{ id: string; code: string }> = [];
  const deps = {
    digitalHuman: {
      getAvatarGeneration: async () => ({ id: 'generation-avatar-preflight', status: 'PENDING', outputAssetId: null, externalTaskId: null }),
      markAvatarRunning: async () => undefined,
      getAvatarClip: async () => null,
      failAvatar: async (id: string, error: { code: string }) => { failures.push({ id, code: error.code }); },
    },
  } as never;
  const job = { id: 'job-avatar-preflight', projectId: 'project-1', state: 'RUNNING', payload: { schemaVersion: 'DIGITAL_HUMAN_JOB_PAYLOAD_V1', kind: 'AVATAR', generationId: 'generation-avatar-preflight', projectId: 'project-1', correlationId: 'corr-preflight' } } as never;
  await assert.rejects(createDigitalHumanJobHandler(deps)(job, 'attempt-avatar-preflight', new AbortController().signal), /Avatar source video is not ready/);
  assert.deepEqual(failures, [{ id: 'generation-avatar-preflight', code: 'AVATAR_CLIP_ASSET_NOT_READY' }]);
});

test('Digital Human worker rejects an oversized remote Avatar result before importing it', async () => {
  const failures: Array<{ id: string; code: string }> = [];
  const deps = {
    digitalHuman: {
      getAvatarGeneration: async () => ({ id: 'generation-avatar-large', status: 'PENDING', outputAssetId: null, externalTaskId: null, avatarClipId: 'clip-1', speechAssetId: 'audio-1', avatarProfileId: 'profile-1', model: null, provenance: { parameters: {} } }),
      markAvatarRunning: async () => undefined,
      getAvatarClip: async () => ({ id: 'clip-1', assetId: 'video-1' }),
      markAvatarWaiting: async () => undefined,
      failAvatar: async (id: string, error: { code: string }) => { failures.push({ id, code: error.code }); },
    },
    assets: {
      getProjectAsset: async (_projectId: string, id: string) => id === 'video-1' ? { id, kind: 'VIDEO', lifecycle: 'READY', storageKey: 'video.mp4', metadata: { durationMs: 2_000, format: 'mp4' } } : { id, kind: 'AUDIO', lifecycle: 'READY', storageKey: 'audio.wav', metadata: { durationMs: 2_000, format: 'wav' } },
    },
    avatarProvider: {
      getCapabilities: async () => ({ providerId: 'hzagent', local: false, videoToVideo: true, imageToVideo: false, requiresPublicUrl: true, supportedFormats: ['mp4'] }),
      submitLipSync: async () => ({ externalTaskId: 'remote-large', providerId: 'hzagent', status: 'SUCCEEDED', outputUrl: 'https://provider.test/result.mp4' }),
    },
    staging: { stageAsset: async (id: string) => ({ assetId: id, publicUrl: `https://provider.test/${id}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
    storage: { root: 'C:/contentos-test-storage' },
    fetchImpl: async () => new Response(Buffer.from('large'), { status: 200, headers: { 'content-length': '5' } }),
    maxRemoteResultBytes: 4,
  } as never;
  const job = { id: 'job-avatar-large', projectId: 'project-1', state: 'RUNNING', payload: { schemaVersion: 'DIGITAL_HUMAN_JOB_PAYLOAD_V1', kind: 'AVATAR', generationId: 'generation-avatar-large', projectId: 'project-1', correlationId: 'corr-large' } } as never;
  await assert.rejects(createDigitalHumanJobHandler(deps)(job, 'attempt-avatar-large', new AbortController().signal), /exceeds the configured size limit/);
  assert.deepEqual(failures, [{ id: 'generation-avatar-large', code: 'AVATAR_RESULT_TOO_LARGE' }]);
});
