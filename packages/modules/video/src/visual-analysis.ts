import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { AssetVisualProfileV3 } from '../../../contracts/src/index.js';
import { validateAssetVisualProfileV3 } from '../../../contracts/src/index.js';

export interface VisualAnalysisProvider { analyzeAssetFrames(input: { assetId: string; framePaths: string[]; model?: string; signal?: AbortSignal }): Promise<AssetVisualProfileV3>; }

const responseSchema = z.object({ summary: z.string().trim().min(1), tags: z.array(z.object({ tag: z.string().trim().min(1), confidence: z.number().min(0).max(1), timestampsMs: z.array(z.number().nonnegative()).default([]) })).default([]), recommendedTimestampsMs: z.array(z.number().nonnegative()).default([]) });

export class QwenVisualAnalysisProvider implements VisualAnalysisProvider {
  constructor(private readonly options: { endpoint?: string; apiKey?: string; model?: string; modelVersion?: string; promptVersion?: string; timeoutMs?: number; fetch?: typeof fetch } = {}) {}

  async analyzeAssetFrames(input: { assetId: string; framePaths: string[]; model?: string; signal?: AbortSignal }): Promise<AssetVisualProfileV3> {
    const endpoint = this.options.endpoint || process.env.QWEN_API_URL;
    const apiKey = this.options.apiKey || process.env.QWEN_API_KEY;
    if (!endpoint || !apiKey) throw new Error('QWEN_PROVIDER_NOT_CONFIGURED');
    const images = await Promise.all(input.framePaths.map(async (path) => `data:image/jpeg;base64,${(await readFile(path)).toString('base64')}`));
    const prompt = '请只返回 JSON：summary 字符串；tags 数组（tag、confidence、timestampsMs）；recommendedTimestampsMs 数组。不要推测真实品牌或人物实体，只描述可见画面。';
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.options.timeoutMs ?? 30_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutController.signal]) : timeoutController.signal;
    let response: Response;
    try {
      response = await (this.options.fetch || fetch)(endpoint, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: input.model || this.options.model || process.env.QWEN_MODEL || 'qwen-vl-max', messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.map((image) => ({ type: 'image_url', image_url: { url: image } }))] }], temperature: 0, response_format: { type: 'json_object' } }), signal });
    } catch (error) {
      if (signal.aborted) throw new Error(input.signal?.aborted ? 'QWEN_CANCELLED' : 'QWEN_TIMEOUT');
      throw error;
    } finally { clearTimeout(timeout); }
    if (!response.ok) throw new Error(`QWEN_HTTP_${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('QWEN_EMPTY_RESPONSE');
    let parsed: unknown;
    try { parsed = JSON.parse(content.replace(/^```json\s*/u, '').replace(/\s*```$/u, '')); } catch { throw new Error('QWEN_INVALID_JSON'); }
    const value = responseSchema.parse(parsed);
    const profile: AssetVisualProfileV3 = { assetId: input.assetId, ...value, modelProvider: 'QWEN_VL', modelName: input.model || this.options.model || process.env.QWEN_MODEL || 'qwen-vl-max', modelVersion: this.options.modelVersion || process.env.QWEN_MODEL_VERSION || 'unknown', promptVersion: this.options.promptVersion || 'qwen-visual-v1', analysisVersion: 'asset-profile-v1', createdAt: new Date().toISOString() };
    validateAssetVisualProfileV3(profile);
    return profile;
  }
}
