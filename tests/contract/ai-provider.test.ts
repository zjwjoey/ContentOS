import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAIRequest,
  validateModelProfile,
  validatePromptVersion,
  type AIRequest,
  type AIResult,
  type ModelProfile,
  type PromptVersion,
} from '../../packages/contracts/src/index.js';

const modelProfile: ModelProfile = {
  id: 'model-profile-fake', providerId: 'fake', modelId: 'fake-zh-v1',
  displayName: 'Fake Chinese V1', capabilities: ['TEXT', 'STRUCTURED'],
  maxInputCharacters: 20_000, maxOutputTokens: 2_000, enabled: true,
};

const promptVersion: PromptVersion = {
  id: 'prompt-director-script-v1', key: 'director.script.v1', version: 1,
  templateHash: 'sha256:prompt-hash', requiredVariables: ['topic', 'coreThesis'],
};

const request: AIRequest = {
  requestId: 'ai-request-1', promptKey: promptVersion.key, promptVersion: 1,
  modelProfileId: modelProfile.id, input: '请根据选题生成一版中文短视频脚本。',
  maxOutputTokens: 500, temperature: 0.4,
};

test('AI contracts validate model profiles, prompt versions and bounded requests', () => {
  assert.doesNotThrow(() => validateModelProfile(modelProfile));
  assert.doesNotThrow(() => validatePromptVersion(promptVersion));
  assert.doesNotThrow(() => validateAIRequest(request));
  assert.throws(() => validateAIRequest({ ...request, input: 'x'.repeat(20_001) }), /input/);
  assert.throws(() => validateAIRequest({ ...request, maxOutputTokens: 0 }), /maxOutputTokens/);
});

test('AI result shape has usage and no credential-shaped public fields', () => {
  const result: AIResult<string> = {
    requestId: request.requestId, providerId: 'fake', modelId: modelProfile.modelId,
    output: '这是确定性的中文结果。',
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
  };
  assert.equal(result.output.includes('中文'), true);
  for (const forbidden of ['apiKey', 'accessToken', 'refreshToken', 'cookie', 'credentialRef']) {
    assert.equal(Object.hasOwn(result, forbidden), false, `public result must not expose ${forbidden}`);
  }
});

test('AI provider errors and capabilities remain provider-neutral', async () => {
  const provider: import('../../packages/contracts/src/index.js').AIProvider = {
    providerId: 'fake',
    supports: (capability) => capability === 'TEXT' || capability === 'STRUCTURED',
    generateText: async () => ({ requestId: request.requestId, providerId: 'fake', modelId: modelProfile.modelId, output: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
    generateStructured: async <T>() => ({ requestId: request.requestId, providerId: 'fake', modelId: modelProfile.modelId, output: {} as T, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
  };
  assert.equal(provider.supports('TEXT'), true);
  assert.equal(provider.supports('STRUCTURED'), true);
  assert.equal(provider.supports('EMBEDDING'), false);
  assert.equal((await provider.generateText(request)).providerId, 'fake');
});
