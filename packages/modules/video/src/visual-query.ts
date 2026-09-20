import { z } from 'zod';
import { qwenEndpoint } from './qwen-endpoint.js';

export interface VisualQueryProvider {
  generateQueries(input: { sentenceId: string; text: string; model?: string; signal?: AbortSignal }): Promise<{ queries: string[]; provider: string; model: string; promptVersion: string }>;
}

const responseSchema = z.object({ queries: z.array(z.string().trim().min(1)).min(3).max(6) });

function ruleQueries(text: string): string[] {
  const normalized = text.replace(/[，。！？；：、“”‘’（）()]/gu, ' ').trim();
  const subject = normalized.split(/\s+/u).filter(Boolean).slice(0, 8).join(' ');
  return [...new Set([subject, `${subject} 真实场景`, `${subject} 近景细节`, `${subject} 人物活动`, `${subject} 环境全景`].filter(Boolean))].slice(0, 5);
}

export class RuleVisualQueryProvider implements VisualQueryProvider {
  async generateQueries(input: { sentenceId: string; text: string }): Promise<{ queries: string[]; provider: string; model: string; promptVersion: string }> {
    return { queries: ruleQueries(input.text), provider: 'RULES', model: 'rules-v3', promptVersion: 'visual-query-v1' };
  }
}

export class QwenVisualQueryProvider implements VisualQueryProvider {
  constructor(private readonly options: { endpoint?: string; apiKey?: string; model?: string; promptVersion?: string; timeoutMs?: number; fetch?: typeof fetch } = {}) {}

  async generateQueries(input: { sentenceId: string; text: string; model?: string; signal?: AbortSignal }): Promise<{ queries: string[]; provider: string; model: string; promptVersion: string }> {
    const configuredEndpoint = this.options.endpoint || process.env.QWEN_BASE_URL || process.env.QWEN_API_URL;
    const apiKey = this.options.apiKey || process.env.QWEN_API_KEY;
    const model = input.model || this.options.model || process.env.QWEN_TEXT_MODEL || process.env.QWEN_MODEL || 'qwen-plus';
    if (!configuredEndpoint || !apiKey) throw new Error('QWEN_PROVIDER_NOT_CONFIGURED');
    const endpoint = qwenEndpoint(configuredEndpoint, '/chat/completions');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    try {
      const response = await (this.options.fetch || fetch)(endpoint, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: `请只返回 JSON，格式为 {"queries":[3到6个中文视觉检索短语]}。不要验证或猜测真实品牌、人物、客户或门店实体。文案：${input.text}` }] }), signal });
      if (!response.ok) throw new Error(`QWEN_HTTP_${response.status}`);
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error('QWEN_EMPTY_RESPONSE');
      let parsed: unknown;
      try { parsed = JSON.parse(content.replace(/^```json\s*/u, '').replace(/\s*```$/u, '')); } catch { throw new Error('QWEN_INVALID_JSON'); }
      const value = responseSchema.parse(parsed);
      const queries = [...new Set(value.queries)].slice(0, 6);
      if (queries.length < 3) throw new Error('QWEN_INVALID_QUERY_COUNT');
      return { queries, provider: 'QWEN_TEXT', model, promptVersion: this.options.promptVersion || 'qwen-visual-query-v1' };
    } catch (error) {
      if (signal.aborted) throw new Error(input.signal?.aborted ? 'QWEN_CANCELLED' : 'QWEN_TIMEOUT');
      throw error;
    } finally { clearTimeout(timeout); }
  }
}

export function createVisualQueryProvider(options: { fetch?: typeof fetch } = {}): VisualQueryProvider {
  if ((process.env.QWEN_BASE_URL || process.env.QWEN_API_URL) && process.env.QWEN_API_KEY) return new QwenVisualQueryProvider(options);
  return new RuleVisualQueryProvider();
}
