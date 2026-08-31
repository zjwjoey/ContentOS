import { AIProviderError, type AIProvider } from './ai-provider.js';
import type { AIRequest, AIResult, AIProviderCapability, AIUsage } from '../../../contracts/src/index.js';

export type AIProviderConfigurationStatus = 'CONFIGURED' | 'NOT_CONFIGURED';
export interface AIProviderConfig { provider: 'fake' | 'openai-compatible'; baseUrl: string; modelId: string; apiKeyConfigured: boolean; status: AIProviderConfigurationStatus; }
export interface OpenAICompatibleProviderOptions { apiKey: string; baseUrl: string; modelId: string; fetch?: typeof globalThis.fetch; }

function trimBaseUrl(value: string): string { return value.trim().replace(/\/$/, ''); }
export function readAIProviderConfig(env: Record<string, string | undefined> = process.env): AIProviderConfig {
  const provider = env.CONTENTOS_AI_PROVIDER?.trim().toLowerCase() === 'openai-compatible' ? 'openai-compatible' : 'fake';
  const baseUrl = trimBaseUrl(env.CONTENTOS_AI_BASE_URL || 'https://api.openai.com/v1');
  const modelId = env.CONTENTOS_AI_MODEL?.trim() || 'gpt-4o-mini';
  const apiKeyConfigured = Boolean(env.CONTENTOS_AI_API_KEY?.trim());
  return { provider, baseUrl, modelId, apiKeyConfigured, status: provider === 'fake' || apiKeyConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED' };
}

function usage(value: unknown, inputLength: number, outputLength: number): AIUsage {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const inputTokens = Number(candidate.prompt_tokens ?? inputLength);
  const outputTokens = Number(candidate.completion_tokens ?? outputLength);
  const totalTokens = Number(candidate.total_tokens ?? inputTokens + outputTokens);
  return { inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0, outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0, totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0 };
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly providerId = 'openai-compatible';
  private readonly request: typeof globalThis.fetch;
  private readonly baseUrl: string;
  constructor(private readonly options: OpenAICompatibleProviderOptions) { if (!options.apiKey.trim()) throw new AIProviderError('AUTHENTICATION_FAILED', 'AI provider API key is not configured', false); this.baseUrl = trimBaseUrl(options.baseUrl); this.request = options.fetch || globalThis.fetch.bind(globalThis); }
  supports(capability: AIProviderCapability): boolean { return capability === 'TEXT' || capability === 'STRUCTURED'; }
  async generateText(request: AIRequest): Promise<AIResult<string>> { const response = await this.call(request, false); const output = this.content(response); return { requestId: request.requestId, providerId: this.providerId, modelId: this.options.modelId, output, usage: usage(response.usage, request.input.length, output.length) }; }
  async generateStructured<T>(request: AIRequest): Promise<AIResult<T>> { const response = await this.call(request, true); const output = this.content(response); try { return { requestId: request.requestId, providerId: this.providerId, modelId: this.options.modelId, output: JSON.parse(output) as T, usage: usage(response.usage, request.input.length, output.length) }; } catch { throw new AIProviderError('INVALID_STRUCTURED_OUTPUT', 'AI provider returned invalid JSON', false); } }
  private async call(request: AIRequest, structured: boolean): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.request(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` }, body: JSON.stringify({ model: this.options.modelId, messages: [{ role: 'user', content: request.input }], max_tokens: request.maxOutputTokens, ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...(structured ? { response_format: { type: 'json_object' } } : {}) }) }); }
    catch { throw new AIProviderError('UNAVAILABLE', 'AI provider request was unavailable'); }
    if (!response.ok) { const status = response.status; if (status === 401 || status === 403) throw new AIProviderError('AUTHENTICATION_FAILED', 'AI provider authentication failed', false); if (status === 429) throw new AIProviderError('RATE_LIMITED', 'AI provider rate limit reached'); throw new AIProviderError(status >= 500 ? 'UNAVAILABLE' : 'INVALID_REQUEST', `AI provider request failed (${status})`, status >= 500); }
    const body = await response.json() as unknown;
    if (!body || typeof body !== 'object') throw new AIProviderError('INVALID_STRUCTURED_OUTPUT', 'AI provider returned an invalid response', false);
    return body as Record<string, unknown>;
  }
  private content(response: Record<string, unknown>): string { const choices = response.choices; const first = Array.isArray(choices) ? choices[0] : undefined; const message = first && typeof first === 'object' ? (first as Record<string, unknown>).message : undefined; const value = message && typeof message === 'object' ? (message as Record<string, unknown>).content : undefined; if (typeof value !== 'string' || !value.trim()) throw new AIProviderError('INVALID_STRUCTURED_OUTPUT', 'AI provider returned empty content', false); return value; }
}

export function createConfiguredAIProvider(env: Record<string, string | undefined> = process.env): OpenAICompatibleProvider | null {
  const config = readAIProviderConfig(env); if (config.provider !== 'openai-compatible' || !env.CONTENTOS_AI_API_KEY?.trim()) return null;
  return new OpenAICompatibleProvider({ apiKey: env.CONTENTOS_AI_API_KEY, baseUrl: config.baseUrl, modelId: config.modelId });
}
