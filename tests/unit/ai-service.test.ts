import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptRegistry } from '../../packages/modules/ai/src/prompt-registry.js';
import { FakeAIProvider } from '../../packages/modules/ai/src/fake-provider.js';
import { AIProviderError } from '../../packages/modules/ai/src/ai-provider.js';
import type { AIRequest } from '../../packages/contracts/src/index.js';

const request: AIRequest = {
  requestId: 'request-1', promptKey: 'director.script.v1', promptVersion: 1,
  modelProfileId: 'fake-profile', input: '选题：门店经营\n核心观点：先验证，再扩大投入。', maxOutputTokens: 500,
};

test('PromptRegistry renders immutable Director templates and rejects missing variables', () => {
  const registry = new PromptRegistry();
  const rendered = registry.render('director.script.v1', { topic: '门店经营', coreThesis: '先验证，再扩大投入。' });
  assert.equal(rendered.promptVersion.key, 'director.script.v1');
  assert.equal(rendered.promptVersion.version, 1);
  assert.match(rendered.input, /门店经营/);
  assert.doesNotMatch(rendered.input, /\{\{[^}]+\}\}/);
  assert.throws(() => registry.render('director.script.v1', { topic: '缺少核心观点' }), /coreThesis/);
  assert.throws(() => registry.render('missing.prompt', {}), /Prompt version not found/);
});

test('FakeAIProvider returns deterministic Chinese text and structured storyboard output', async () => {
  const provider = new FakeAIProvider();
  const first = await provider.generateText(request);
  const second = await provider.generateText(request);
  assert.equal(first.output, second.output);
  assert.match(first.output, /先验证/);
  const storyboard = await provider.generateStructured<{ scenes: Array<{ sceneIndex: number }> }>({ ...request, promptKey: 'director.storyboard.v1' });
  assert.ok(storyboard.output.scenes.length > 0);
  assert.equal(storyboard.output.scenes[0]?.sceneIndex, 1);
});

test('FakeAIProvider normalizes unavailable, rate-limit, auth and invalid-structure failures', async () => {
  for (const [outcome, code, retryable] of [
    ['UNAVAILABLE', 'UNAVAILABLE', true], ['RATE_LIMITED', 'RATE_LIMITED', true],
    ['AUTHENTICATION_FAILED', 'AUTHENTICATION_FAILED', false], ['INVALID_STRUCTURED_OUTPUT', 'INVALID_STRUCTURED_OUTPUT', false],
  ] as const) {
    const provider = new FakeAIProvider(outcome);
    await assert.rejects(provider.generateText(request), (error: unknown) => {
      assert.ok(error instanceof AIProviderError);
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      return true;
    });
  }
});
