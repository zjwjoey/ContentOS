import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAvatarGenerationRequest, validateSpeechGenerationRequest } from '../../packages/contracts/src/index.js';
import { DigitalHumanProviderError, FakeAvatarProvider, FakeSpeechProvider, IndexTTS25SpeechProvider, SignedProviderMediaStaging, SyntheticTimingProvider, createRuntimeDigitalHumanProviders, isPublicHttpUrl, speechCapabilityError, subtitleTimelineToAss, subtitleTimelineToSrt, verifyProviderMediaToken } from '../../packages/modules/digital-human/src/index.js';

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
  await assert.rejects(() => runtime.avatar.getCapabilities(), /interface-only/);
  assert.equal(runtime.mediaStagingConfigured, false);
});

test('IndexTTS adapter preserves gateway capabilities', async () => {
  const speech = new IndexTTS25SpeechProvider({ baseUrl: 'http://speech.test', fetchImpl: async () => new Response(JSON.stringify({ capabilities: { requiresReferenceAudio: true, languages: ['zh'] } }), { status: 200 }) });
  assert.equal((await speech.getCapabilities()).requiresReferenceAudio, true);
});

test('speech capability preflight rejects unsupported provider inputs before generation', () => {
  const capabilities = { providerId: 'indextts25', local: true, voiceClone: true, emotion: false, speed: true, languages: ['zh'], supportsReferenceAudio: true, requiresReferenceAudio: true, supportsVoiceId: false, maxTextCharacters: 5 };
  assert.equal(speechCapabilityError(capabilities, { text: '你好', language: 'zh', speed: 1, emotion: 'natural', hasReferenceAudio: false, hasProviderVoiceId: false })?.code, 'VOICE_REFERENCE_REQUIRED');
  assert.equal(speechCapabilityError(capabilities, { text: '你好', language: 'en', speed: 1, emotion: 'natural', hasReferenceAudio: true, hasProviderVoiceId: false })?.code, 'SPEECH_LANGUAGE_UNSUPPORTED');
  assert.equal(speechCapabilityError(capabilities, { text: '你好', language: 'zh', speed: 1, emotion: 'happy', hasReferenceAudio: true, hasProviderVoiceId: false })?.code, 'SPEECH_EMOTION_UNSUPPORTED');
  assert.equal(speechCapabilityError(capabilities, { text: '超过五个字符', language: 'zh', speed: 1, emotion: 'natural', hasReferenceAudio: true, hasProviderVoiceId: false })?.code, 'SPEECH_TEXT_TOO_LONG');
  assert.equal(speechCapabilityError({ ...capabilities, supportsVoiceId: true }, { text: '你好', language: 'zh', speed: 1, emotion: 'natural', hasReferenceAudio: true, hasProviderVoiceId: true }), null);
});

test('provider HTTP failures are bounded and classified as retryable outages', async () => {
  const hangingFetch: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  const speech = new IndexTTS25SpeechProvider({ baseUrl: 'http://speech.test', requestTimeoutMs: 10, fetchImpl: hangingFetch });
  await assert.rejects(() => speech.generateSpeech({ requestId: 'r', projectId: 'p', jobId: 'j', attemptId: 'a', correlationId: 'c', text: '你好', language: 'zh', speed: 1, emotion: 'natural' }), (error: unknown) => error instanceof DigitalHumanProviderError && error.code === 'UNAVAILABLE' && error.retryable);
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
  const runtime = createRuntimeDigitalHumanProviders({ CONTENTOS_SPEECH_PROVIDER: 'fake-speech', CONTENTOS_AVATAR_PROVIDER: 'hzagent', CONTENTOS_MEDIA_STAGING_PROVIDER: 'signed-url', CONTENTOS_MEDIA_STAGING_BASE_URL: 'http://127.0.0.1:3000', CONTENTOS_MEDIA_STAGING_SECRET: 'secret' });
  assert.equal(runtime.mediaStagingConfigured, false);
});
