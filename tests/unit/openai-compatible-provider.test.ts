import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider, readAIProviderConfig } from '../../packages/modules/ai/src/index.js';

test('OpenAI-compatible provider sends request without exposing API key and maps usage', async () => {
  let request: Request | undefined;
  const provider = new OpenAICompatibleProvider({ apiKey: 'secret-key', baseUrl: 'https://ai.example.test/v1', modelId: 'model-x', fetch: async (input, init) => { request = new Request(input, init); return new Response(JSON.stringify({ id: 'chat-1', choices: [{ message: { content: '{"answer":"ok"}' } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  const result = await provider.generateStructured<{ answer: string }>({ requestId: 'req-1', promptKey: 'test', promptVersion: 1, modelProfileId: 'profile', input: 'hello', maxOutputTokens: 100 });
  assert.deepEqual(result.output, { answer: 'ok' });
  assert.equal(result.usage.totalTokens, 7);
  assert.equal(request?.headers.get('authorization'), 'Bearer secret-key');
  assert.match(await request!.text(), /hello/);
});

test('AI provider config reports NOT_CONFIGURED without a key', () => {
  assert.equal(readAIProviderConfig({ CONTENTOS_AI_PROVIDER: 'openai-compatible', CONTENTOS_AI_BASE_URL: 'https://example.test', CONTENTOS_AI_MODEL: 'model' }).status, 'NOT_CONFIGURED');
  assert.equal(readAIProviderConfig({ CONTENTOS_AI_PROVIDER: 'fake' }).status, 'CONFIGURED');
});
