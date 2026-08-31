import type { ModelProfile } from '../../../contracts/src/index.js';
import { FakeAIProvider } from './fake-provider.js';
import { createConfiguredAIProvider, readAIProviderConfig } from './openai-compatible-provider.js';
import type { AIProvider } from './ai-provider.js';

export function createRuntimeAI(env: Record<string, string | undefined> = process.env): { provider: AIProvider; profile: ModelProfile; status: 'CONFIGURED' | 'NOT_CONFIGURED' } {
  const config = readAIProviderConfig(env);
  const real = createConfiguredAIProvider(env);
  const provider = real || new FakeAIProvider();
  const modelId = real ? config.modelId : 'fake-zh-v1';
  const profile: ModelProfile = { id: `${provider.providerId}-profile-runtime`, providerId: provider.providerId, modelId, displayName: real ? `Real AI · ${modelId}` : 'Fake Chinese V1', capabilities: ['TEXT', 'STRUCTURED'], maxInputCharacters: 20_000, maxOutputTokens: 2_000, enabled: true };
  return { provider, profile, status: config.status };
}
