import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAvatarGenerationRequest, validateSpeechGenerationRequest } from '../../packages/contracts/src/index.js';
import { FakeAvatarProvider, FakeSpeechProvider, SyntheticTimingProvider } from '../../packages/modules/digital-human/src/index.js';

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
