import type { FastifyInstance } from 'fastify';
import { QwenVisualQueryProvider } from '../../../packages/modules/video/src/index.js';

function qwenStatus() {
  return {
    configured: Boolean(process.env.QWEN_API_KEY && (process.env.QWEN_BASE_URL || process.env.QWEN_API_URL)),
    vlModel: process.env.QWEN_VL_MODEL || process.env.QWEN_MODEL || 'qwen-vl-max',
    textModel: process.env.QWEN_TEXT_MODEL || process.env.QWEN_MODEL || 'qwen-plus',
    embeddingModel: process.env.QWEN_EMBEDDING_MODEL || 'text-embedding-v3',
  };
}
export function registerQwenRoutes(app: FastifyInstance): void {
  app.get('/api/v1/ai/qwen/status', async () => qwenStatus());
  app.post('/api/v1/ai/qwen/test', async (_request, reply) => {
    if (!qwenStatus().configured) return reply.code(503).send({ error: { code: 'QWEN_PROVIDER_NOT_CONFIGURED' } });
    try {
      const result = await new QwenVisualQueryProvider().generateQueries({ sentenceId: 'settings-test', text: '测试零售门店画面' });
      return { status: 'HEALTHY', provider: result.provider, model: result.model };
    } catch (error) {
      return reply.code(502).send({ error: { code: error instanceof Error ? error.message : 'QWEN_TEST_FAILED' } });
    }
  });
}
