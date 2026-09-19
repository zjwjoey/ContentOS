import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { ExternalVideoProvider } from '../../../packages/modules/video/src/index.js';
import { getProviderHealth, recordProviderHealth } from '../../../packages/modules/video/src/index.js';

export function registerMediaProviderRoutes(app: FastifyInstance, provider: ExternalVideoProvider, db?: Pool): void {
  app.get('/api/v1/media-providers', async () => {
    const cached = getProviderHealth(provider.name); const row = db ? (await db.query('select configured,healthy,message,rate_limit,last_checked_at from media_provider_status where provider=$1', [provider.name]).catch(() => ({ rows: [] }))).rows[0] as Record<string, unknown> | undefined : undefined;
    return { items: [{ id: provider.name, configured: provider.configured, healthy: row?.healthy ?? cached.ok ?? null, message: row?.message ?? cached.message ?? null, rateLimit: row?.rate_limit ?? cached.rateLimit ?? null, lastCheckedAt: row?.last_checked_at ?? cached.checkedAt ?? null }] };
  });
  app.post('/api/v1/media-providers/pexels/test', async (_request, reply) => {
    if (!provider.configured) return reply.code(422).send({ error: { code: 'PEXELS_NOT_CONFIGURED', message: '服务端尚未配置 PEXELS_API_KEY。', details: [] } });
    const health = provider.health ? await provider.health() : { ok: true }; recordProviderHealth(provider.name, health); await db?.query('insert into media_provider_status(provider,configured,healthy,message,rate_limit,last_checked_at) values($1,$2,$3,$4,$5,now()) on conflict(provider) do update set configured=excluded.configured,healthy=excluded.healthy,message=excluded.message,rate_limit=excluded.rate_limit,last_checked_at=now()', [provider.name, provider.configured, health.ok, health.message || null, health.rateLimit || null]).catch(() => undefined);
    return health.ok ? { ok: true, message: 'Pexels 连接正常。', rateLimit: health.rateLimit || null } : reply.code(502).send({ error: { code: 'PEXELS_CONNECTION_FAILED', message: health.message || 'Pexels 连接失败。', details: [] } });
  });
}
