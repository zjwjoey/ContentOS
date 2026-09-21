import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAvatarGenerationRequest, validateSpeechGenerationRequest } from '../../packages/contracts/src/index.js';
import { DigitalHumanProviderError, FakeAvatarProvider, FakeSpeechProvider, HzAgentAvatarProvider, IndexTTS25SpeechProvider, SignedProviderMediaStaging, SyntheticTimingProvider, createRuntimeDigitalHumanProviders, isPublicHttpUrl, subtitleTimelineToAss, subtitleTimelineToSrt, verifyProviderMediaToken } from '../../packages/modules/digital-human/src/index.js';

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

test('unconfigured runtime providers fail closed during capability checks', async () => {
  const runtime = createRuntimeDigitalHumanProviders({ CONTENTOS_SPEECH_PROVIDER: 'missing-speech', CONTENTOS_AVATAR_PROVIDER: 'hzagent' });
  await assert.rejects(() => runtime.speech.getCapabilities(), /not configured/);
  await assert.rejects(() => runtime.avatar.getCapabilities(), /API key/);
  assert.equal(runtime.mediaStagingConfigured, false);
});

test('HTTP adapters preserve provider capability, task status, model version, and cost', async () => {
  const speech = new IndexTTS25SpeechProvider({ baseUrl: 'http://speech.test', fetchImpl: async () => new Response(JSON.stringify({ capabilities: { requiresReferenceAudio: true, languages: ['zh'] } }), { status: 200 }) });
  assert.equal((await speech.getCapabilities()).requiresReferenceAudio, true);
  let call = 0; const requests: RequestInit[] = [];
  const avatar = new HzAgentAvatarProvider({ baseUrl: 'http://avatar.test', apiKey: 'test-only', authHeaderName: 'x-api-key', authScheme: '', fetchImpl: async (_input, init) => { requests.push(init || {}); return new Response(JSON.stringify(call++ === 0 ? { task_id: 'task-1', status: 'RUNNING', model: 'avatar-v1', model_version: '2026.09', cost_amount: '1.25', cost_currency: 'RMB' } : { state: 'COMPLETED', result_url: 'https://cdn.test/result.mp4', model_version: '2026.09', cost_amount: 1.25, cost_currency: 'RMB' }), { status: 200 }); } });
  assert.equal(avatar.providerId, 'hzagent');
  const submitted = await avatar.submitLipSync({ requestId: 'r', projectId: 'p', jobId: 'j', attemptId: 'a', correlationId: 'c', audioUrl: 'https://cdn.test/a.wav', videoUrl: 'https://cdn.test/v.mp4', parameters: {} });
  assert.equal(submitted.status, 'RUNNING'); assert.equal(submitted.modelVersion, '2026.09'); assert.equal(submitted.costAmount, 1.25);
  const completed = await avatar.getTask('task-1'); assert.equal(completed.status, 'SUCCEEDED'); assert.equal(completed.outputUrl, 'https://cdn.test/result.mp4'); assert.equal(completed.costCurrency, 'RMB');
  assert.equal((requests[0]?.headers as Record<string, string>)['x-api-key'], 'test-only'); assert.equal((requests[0]?.headers as Record<string, string>)['Idempotency-Key'], 'r'); assert.equal((requests[1]?.headers as Record<string, string>)['x-api-key'], 'test-only');
});

test('HTTP avatar capabilities are health-checked with provider authentication', async () => {
  let path = ''; let authorization = '';
  const avatar = new HzAgentAvatarProvider({ baseUrl: 'https://avatar.test', apiKey: 'test-only', fetchImpl: async (input, init) => { path = new URL(String(input)).pathname; authorization = String((init?.headers as Record<string, string>)?.authorization || ''); return new Response(JSON.stringify({ capabilities: { videoToVideo: true, requiresPublicUrl: true, supportedFormats: ['mp4'], supported_audio_formats: ['wav'], maxDurationSeconds: 60 } }), { status: 200 }); } });
  const capabilities = await avatar.getCapabilities();
  assert.equal(path, '/v1/capabilities'); assert.equal(authorization, 'Bearer test-only'); assert.equal(capabilities.maxDurationSeconds, 60); assert.deepEqual(capabilities.supportedFormats, ['mp4']); assert.deepEqual(capabilities.supportedAudioFormats, ['wav']);
});

test('HTTP avatar adapters reject private result URLs at the provider boundary', async () => {
  const avatar = new HzAgentAvatarProvider({ baseUrl: 'https://avatar.test', apiKey: 'test-only', fetchImpl: async () => new Response(JSON.stringify({ status: 'SUCCEEDED', result_url: 'http://127.0.0.1:8788/result.mp4' }), { status: 200 }) });
  await assert.rejects(() => avatar.getTask('task-private'), /unsafe result URL/);
});

test('provider HTTP failures are bounded and classified as retryable outages', async () => {
  const hangingFetch: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  const speech = new IndexTTS25SpeechProvider({ baseUrl: 'http://speech.test', requestTimeoutMs: 10, fetchImpl: hangingFetch });
  await assert.rejects(() => speech.generateSpeech({ requestId: 'r', projectId: 'p', jobId: 'j', attemptId: 'a', correlationId: 'c', text: '你好', language: 'zh', speed: 1, emotion: 'natural' }), (error: unknown) => error instanceof DigitalHumanProviderError && error.code === 'UNAVAILABLE' && error.retryable);
  const avatar = new HzAgentAvatarProvider({ baseUrl: 'http://avatar.test', apiKey: 'test-only', requestTimeoutMs: 10, fetchImpl: hangingFetch });
  await assert.rejects(() => avatar.getTask('task-1'), (error: unknown) => error instanceof DigitalHumanProviderError && error.code === 'UNAVAILABLE' && error.retryable);
});

test('signed provider media staging issues expiring, tamper-resistant URLs', async () => {
  const staging = new SignedProviderMediaStaging({ baseUrl: 'https://contentos.example', secret: 'test-staging-secret' });
  const result = await staging.stageAsset('asset-video-1', { ttlSeconds: 60 }); const token = new URL(result.publicUrl).searchParams.get('token') || '';
  const verified = verifyProviderMediaToken(token, 'test-staging-secret'); assert.equal(verified?.assetId, 'asset-video-1'); assert.ok(verified && verified.expiresAtSeconds > Math.floor(Date.now() / 1000));
  assert.equal(verifyProviderMediaToken(`${token}tampered`, 'test-staging-secret'), null); assert.equal(verifyProviderMediaToken(token, 'wrong-secret'), null);
});

test('provider staging rejects private URLs and runtime marks them unavailable', async () => {
  assert.equal(isPublicHttpUrl('https://media.example/assets/1'), true);
  assert.equal(isPublicHttpUrl('http://127.0.0.1:3000/assets/1'), false);
  assert.equal(isPublicHttpUrl('http://192.168.1.10/assets/1'), false);
  const runtime = createRuntimeDigitalHumanProviders({ CONTENTOS_SPEECH_PROVIDER: 'fake-speech', CONTENTOS_AVATAR_PROVIDER: 'hzagent', HZAGENT_API_KEY: 'test-only', CONTENTOS_MEDIA_STAGING_PROVIDER: 'signed-url', CONTENTOS_MEDIA_STAGING_BASE_URL: 'http://127.0.0.1:3000', CONTENTOS_MEDIA_STAGING_SECRET: 'secret' });
  assert.equal(runtime.mediaStagingConfigured, false);
});
