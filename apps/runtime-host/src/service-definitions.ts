import { createDatabase, migrateUp } from '../../../packages/database/src/index.js';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ServiceDefinition } from '../../../packages/runtime-core/src/index.js';

export interface RuntimeServicesOptions { appRoot: string; env: Record<string, string | undefined>; safeMode: boolean; config?: import('../../../packages/runtime-core/src/index.js').RuntimeConfig; }
const tsx = (appRoot: string) => resolve(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const processService = (id: string, label: string, entry: string, options: RuntimeServicesOptions, dependsOn: string[], required: boolean, readiness: 'PROCESS' | 'STDOUT_JSON_READY' = 'STDOUT_JSON_READY'): ServiceDefinition => { const packaged = options.config?.launchMode === 'PACKAGED'; const sourceEntry = resolve(options.appRoot, entry); const builtEntry = resolve(options.appRoot, 'dist', entry.replace(/\.ts$/u, '.js')); return { id, label, kind: 'PROCESS', required, dependsOn, startupTimeoutMs: 45_000, shutdownTimeoutMs: 10_000, restartClass: 'TRANSIENT', restartPolicy: { enabled: true, maxRestarts: 3, windowMs: 60_000, backoffMs: [1_000, 3_000, 10_000] }, command: process.execPath, args: packaged ? [builtEntry] : [tsx(options.appRoot), sourceEntry], env: { NODE_ENV: packaged ? 'production' : 'development' }, readiness }; };

export function createServiceDefinitions(options: RuntimeServicesOptions): ServiceDefinition[] {
  const env = options.env; const databaseUrl = options.config?.databaseUrl || env.DATABASE_URL || '';
  const db: ServiceDefinition = { id: 'database', label: 'Database', kind: 'EXTERNAL', required: true, dependsOn: [], startupTimeoutMs: 20_000, shutdownTimeoutMs: 1_000, restartPolicy: { enabled: false, maxRestarts: 0, windowMs: 60_000, backoffMs: [] }, healthCheck: async () => { const pool = await createDatabase(databaseUrl); try { await pool.query('select 1'); return { state: 'READY', message: 'PostgreSQL reachable' }; } finally { await pool.end(); } } };
  const migration: ServiceDefinition = { id: 'migration', label: 'Schema Migration', kind: 'TASK', required: true, dependsOn: ['database'], startupTimeoutMs: 60_000, shutdownTimeoutMs: 1_000, restartPolicy: { enabled: false, maxRestarts: 0, windowMs: 60_000, backoffMs: [] }, start: async () => { const pool = await createDatabase(databaseUrl); try { await migrateUp(pool); } finally { await pool.end(); } }, healthCheck: async () => ({ state: 'READY', message: 'Schema ready' }) };
  const apiPort = options.config?.apiPort || Number(env.PORT || 3000); const webPort = options.config?.webPort || Number(env.WEB_PORT || 3001);
  const api: ServiceDefinition = { ...processService('api', 'API', 'apps/api/src/main.ts', options, ['database', 'migration'], true, 'PROCESS'), port: apiPort, healthCheck: async () => { const response = await fetch(`http://127.0.0.1:${apiPort}/ready`); return response.ok ? { state: 'READY', message: 'API readiness ready' } : { state: 'FAILED', message: `HTTP ${response.status}` }; } };
  const packaged = options.config?.launchMode === 'PACKAGED';
  const web: ServiceDefinition = { id: 'web', label: 'Web', kind: 'PROCESS', required: true, dependsOn: ['api'], startupTimeoutMs: 60_000, shutdownTimeoutMs: 10_000, restartClass: 'TRANSIENT', restartPolicy: { enabled: true, maxRestarts: 3, windowMs: 60_000, backoffMs: [1_000, 3_000, 10_000] }, command: process.execPath, args: packaged ? [resolve(options.appRoot, 'apps/web/node_modules/next/dist/bin/next'), 'start', '-p', String(webPort), resolve(options.appRoot, 'apps/web')] : [resolve(options.appRoot, 'apps/web/node_modules/next/dist/bin/next'), 'dev', '-p', String(webPort), resolve(options.appRoot, 'apps/web')], env: { NODE_ENV: packaged ? 'production' : 'development', CONTENTOS_API_URL: `http://127.0.0.1:${apiPort}` }, port: webPort, healthCheck: async () => { const response = await fetch(`http://127.0.0.1:${webPort}/`); return response.ok ? { state: 'READY', message: 'Web reachable' } : { state: 'FAILED', message: `HTTP ${response.status}` }; } };
  const asset = processService('asset-worker', 'Asset Worker', 'workers/asset-worker/src/main.ts', options, ['database', 'migration'], true);
  const director = processService('director-worker', 'Director Worker', 'workers/director-worker/src/dev-main.ts', options, ['database', 'migration'], true);
  const video = processService('video-worker', 'Video Worker', 'workers/video-worker/src/main.ts', options, ['database', 'migration'], true);
  const review = processService('review-worker', 'Review Worker', 'workers/review-worker/src/dev-main.ts', options, ['database', 'migration'], true);
  const benchmark = processService('benchmark-worker', 'Benchmark Worker', 'workers/benchmark-worker/src/dev-main.ts', options, ['database', 'migration'], false);
  const digitalHuman = processService('digital-human-worker', 'Digital Human Worker', 'workers/digital-human-worker/src/dev-main.ts', options, ['database', 'migration'], false);
  const publisher = processService('publisher-worker', 'Publisher Worker', 'workers/publisher-worker/src/dev-main.ts', options, ['database', 'migration'], false);
  digitalHuman.capabilityProbe = async () => ({ provider: env.CONTENTOS_HZAGENT_API_KEY ? 'HZAGENT' : 'NOT_CONFIGURED', speech: env.CONTENTOS_INDEXTTS_BASE_URL ? 'CONFIGURED' : 'NOT_CONFIGURED' });
  publisher.capabilityProbe = async () => ({ adapters: env.PUBLISHER_REAL_ADAPTERS_ENABLED === '1' || env.PUBLISHER_REAL_ADAPTERS_ENABLED === 'true' ? 'ENABLED' : 'NOT_CONFIGURED', account: 'LOGIN_REQUIRED' });
  const all = [db, migration, api, asset, director, video, review, benchmark, digitalHuman, publisher, web];
  return options.safeMode ? all.filter((item) => item.required) : all;
}
