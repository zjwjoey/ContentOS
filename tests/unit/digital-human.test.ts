import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAvatarGenerationRequest, validateSpeechGenerationRequest } from '../../packages/contracts/src/index.js';
import { FakeAvatarProvider, FakeSpeechProvider, HzAgentAvatarProvider, IndexTTS25SpeechProvider, SignedProviderMediaStaging, SyntheticTimingProvider, createRuntimeDigitalHumanProviders, subtitleTimelineToAss, subtitleTimelineToSrt, verifyProviderMediaToken } from '../../packages/modules/digital-human/src/index.js';

test('digital human contracts reject unsafe generation requests', () => {
  assert.doesNotThrow(() => validateSpeechGenerationRequest({ requestId: 'r', projectId: 'p', jobId: 'j', attemptId: 'a', correlationId: 'c', text: '你好', language: 'zh', speed: 1, emotion: 'natural' }));
  assert.throws(() => validateSpeechGenerationRequest({ requestId: 'r', projectId: 'p', jobId: 'j', attemptId: 'a', correlationId: 'c', text: 'x', language: 'zh', speed: 9, emotion: 'natural' }), /speed/);
  assert.doesNotThrow(() => validateAvatarGenerationRequest({ requestId: 'r', projectId: 'p', jobId: 'j', attemptId: 'a', correlationId: 'c', audioUrl: 'https://media.example/audio.wav', videoUrl: 'https://media.example/video.mp4', parameters: {} }));
  assert.throws(() => validateAvatarGenerationRequest({ requestId: 'r', projectId: 'p', jobId: 'j', attemptId: 'a', correlationId: 'c', audioUrl: 'file:///secret', videoUrl: 'https://media.example/video.mp4', parameters: {} }), /http/);
});

test('SyntheticTimingProvider creates deterministic sentence cues that cover duration', async () => {
  const timeline = await new SyntheticTimingProvider().align({ text: '第一句。第二句！', durationMs: 2_000, language: 'zh' });
  assert.equal(timeline.cues.length, 2);
  assert.equal(timeline.cues[0]?.startMs, 0);
  assert.equal(timeline.cues.at(-1)?.endMs, 2_000);
  assert.ok((timeline.cues[0]?.endMs || 0) <= (timeline.cues[1]?.startMs || 0));
});

test('fake providers expose capabilities and preserve external task identity', async () => {
  const speech = new FakeSpeechProvider('C:/tmp/test.wav');
  assert.equal((await speech.getCapabilities()).supportsReferenceAudio, true);
  assert.equal((await speech.generateSpeech({ requestId: 'r', projectId: 'p', jobId: 'j', attemptId: 'a', correlationId: 'c', text: '你好', language: 'zh', speed: 1, emotion: 'natural' })).outputPath, 'C:/tmp/test.wav');
  const avatar = new FakeAvatarProvider();
  const task = await avatar.submitLipSync({ requestId: 'r', projectId: 'p', jobId: 'j', attemptId: 'a', correlationId: 'c', audioUrl: 'https://a.invalid/a.wav', videoUrl: 'https://a.invalid/v.mp4', parameters: {} });
  assert.equal((await avatar.getTask(task.externalTaskId)).externalTaskId, task.externalTaskId);
  assert.equal((await avatar.getTask(task.externalTaskId)).status, 'SUCCEEDED');
});

test('runtime provider selection is environment-driven and subtitle exports preserve timing', async () => {
  const runtime = createRuntimeDigitalHumanProviders({ CONTENTOS_SPEECH_PROVIDER: 'fake-speech', CONTENTOS_AVATAR_PROVIDER: 'fake-avatar', CONTENTOS_FAKE_SPEECH_OUTPUT_PATH: 'C:/tmp/test.wav' });
  assert.equal(runtime.speech.providerId, 'fake-speech'); assert.equal(runtime.avatar.providerId, 'fake-avatar');
  const timeline = await new SyntheticTimingProvider().align({ text: '第一句。第二句。', durationMs: 2_500, language: 'zh' });
  assert.match(subtitleTimelineToSrt(timeline), /00:00:00,000 -->/); assert.match(subtitleTimelineToAss(timeline), /Dialogue: 0,/);
  assert.match(subtitleTimelineToAss(timeline), /第一句。/);
});

test('HTTP adapters preserve provider capability, task status, model version, and cost', async () => {
  const speech = new IndexTTS25SpeechProvider({ baseUrl: 'http://speech.test', fetchImpl: async () => new Response(JSON.stringify({ capabilities: { requiresReferenceAudio: true, languages: ['zh'] } }), { status: 200 }) });
  assert.equal((await speech.getCapabilities()).requiresReferenceAudio, true);
  let call = 0;
  const avatar = new HzAgentAvatarProvider({ baseUrl: 'http://avatar.test', apiKey: 'test-only', fetchImpl: async () => new Response(JSON.stringify(call++ === 0 ? { taskId: 'task-1', status: 'RUNNING', model: 'avatar-v1', modelVersion: '2026.09', costAmount: '1.25', costCurrency: 'RMB' } : { status: 'SUCCEEDED', outputUrl: 'https://cdn.test/result.mp4', modelVersion: '2026.09', costAmount: 1.25, costCurrency: 'RMB' }), { status: 200 }) });
  assert.equal(avatar.providerId, 'hzagent');
  const submitted = await avatar.submitLipSync({ requestId: 'r', projectId: 'p', jobId: 'j', attemptId: 'a', correlationId: 'c', audioUrl: 'https://cdn.test/a.wav', videoUrl: 'https://cdn.test/v.mp4', parameters: {} });
  assert.equal(submitted.status, 'RUNNING'); assert.equal(submitted.modelVersion, '2026.09'); assert.equal(submitted.costAmount, 1.25);
  const completed = await avatar.getTask('task-1'); assert.equal(completed.status, 'SUCCEEDED'); assert.equal(completed.outputUrl, 'https://cdn.test/result.mp4'); assert.equal(completed.costCurrency, 'RMB');
});

test('signed provider media staging issues expiring, tamper-resistant URLs', async () => {
  const staging = new SignedProviderMediaStaging({ baseUrl: 'https://contentos.example', secret: 'test-staging-secret' });
  const result = await staging.stageAsset('asset-video-1', { ttlSeconds: 60 }); const token = new URL(result.publicUrl).searchParams.get('token') || '';
  const verified = verifyProviderMediaToken(token, 'test-staging-secret'); assert.equal(verified?.assetId, 'asset-video-1'); assert.ok(verified && verified.expiresAtSeconds > Math.floor(Date.now() / 1000));
  assert.equal(verifyProviderMediaToken(`${token}tampered`, 'test-staging-secret'), null); assert.equal(verifyProviderMediaToken(token, 'wrong-secret'), null);
});
