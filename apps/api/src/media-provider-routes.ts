import type { FastifyInstance } from 'fastify';
import type { ExternalVideoProvider } from '../../../packages/modules/video/src/index.js';

export function registerMediaProviderRoutes(app: FastifyInstance, provider: ExternalVideoProvider): void {
  app.get('/api/v1/media-providers', async () => {
    const health = provider.health ? await provider.health().catch((error) => ({ ok: false, message: error instanceof Error ? error.message : 'provider unavailable' })) : { ok: provider.configured };
    return { items: [{ id: provider.name, configured: provider.configured, healthy: health.ok, message: health.message || null, rateLimit: 'rateLimit' in health ? health.rateLimit || null : null }] };
  });
  app.post('/api/v1/media-providers/pexels/test', async (_request, reply) => {
    if (!provider.configured) return reply.code(422).send({ error: { code: 'PEXELS_NOT_CONFIGURED', message: '服务端尚未配置 PEXELS_API_KEY。', details: [] } });
    const health = provider.health ? await provider.health() : { ok: true };
    return health.ok ? { ok: true, message: 'Pexels 连接正常。', rateLimit: health.rateLimit || null } : reply.code(502).send({ error: { code: 'PEXELS_CONNECTION_FAILED', message: health.message || 'Pexels 连接失败。', details: [] } });
  });
}
