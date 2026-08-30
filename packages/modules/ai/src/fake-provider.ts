import { validateAIRequest, type AIProvider, type AIRequest, type AIResult } from '../../../contracts/src/index.js';
import { AIProviderError, type ProviderErrorCode } from './ai-provider.js';

export type FakeProviderOutcome = 'UNAVAILABLE' | 'RATE_LIMITED' | 'AUTHENTICATION_FAILED' | 'INVALID_STRUCTURED_OUTPUT';

export class FakeAIProvider implements AIProvider {
  readonly providerId = 'fake';

  constructor(private readonly outcome?: FakeProviderOutcome) {}

  supports(capability: 'TEXT' | 'STRUCTURED' | 'EMBEDDING'): boolean {
    return capability === 'TEXT' || capability === 'STRUCTURED';
  }

  private check(request: AIRequest): void {
    validateAIRequest(request);
    if (this.outcome) throw new AIProviderError(this.outcome as ProviderErrorCode, `Fake provider outcome: ${this.outcome}`);
  }

  async generateText(request: AIRequest): Promise<AIResult<string>> {
    this.check(request);
    return { requestId: request.requestId, providerId: this.providerId, modelId: 'fake-zh-v1', output: '标题：先验证，再增长\n开头：很多人第一步就做错了。\n正文：先用小成本验证真实需求，再决定是否扩大投入。\n行动：收藏这条建议。', usage: { inputTokens: request.input.length, outputTokens: 32, totalTokens: request.input.length + 32 } };
  }

  async generateStructured<T>(request: AIRequest): Promise<AIResult<T>> {
    this.check(request);
    if (request.promptKey === 'director.storyboard.v1') {
      return { requestId: request.requestId, providerId: this.providerId, modelId: 'fake-zh-v1', output: { scenes: [
        { sceneIndex: 1, voiceoverText: '很多人第一步就做错了。', durationHintSeconds: 3, visualInstruction: '人物面对账本犹豫', assetKeywords: ['账本'] },
        { sceneIndex: 2, voiceoverText: '先验证真实需求，再扩大投入。', durationHintSeconds: 5, visualInstruction: '展示小规模测试', assetKeywords: ['测试', '门店'] },
      ] } as T, usage: { inputTokens: request.input.length, outputTokens: 40, totalTokens: request.input.length + 40 } };
    }
    if (request.promptKey === 'review.analysis.v1') {
      return { requestId: request.requestId, providerId: this.providerId, modelId: 'fake-zh-v1', output: {
        summary: '当前内容获得稳定触达，互动仍有提升空间。',
        highlights: [{ title: '触达稳定', detail: '播放量保持在健康区间。' }],
        risks: [{ title: '互动偏低', detail: '评论和分享率低于播放增长。' }],
        recommendations: [{ priority: 'HIGH', title: '强化互动钩子', detail: '在结尾加入明确问题，引导评论。' }],
      } as T, usage: { inputTokens: request.input.length, outputTokens: 48, totalTokens: request.input.length + 48 } };
    }
    return { requestId: request.requestId, providerId: this.providerId, modelId: 'fake-zh-v1', output: { title: '先验证，再增长', titleCandidates: ['先验证，再增长'], coverText: '先验证', topicKeywords: ['经营', '验证需求'], hook: '很多人第一步就做错了。', body: '先用小成本验证真实需求，再决定是否扩大投入。', cta: '收藏这条建议。' } as T, usage: { inputTokens: request.input.length, outputTokens: 40, totalTokens: request.input.length + 40 } };
  }
}
