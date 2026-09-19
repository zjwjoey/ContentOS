import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPathAccessService } from '../../packages/modules/local-path/src/index.js';
import { registerLocalPathRoutes } from '../../apps/api/src/local-path-routes.js';

function fakeDb() {
  return { async query(sql: string, params?: unknown[]) { if (sql.startsWith('insert into local_path_grants')) return { rows: [{ id: 'grant-1', path: String(params?.[0]), canonical_path: String(params?.[1]), kind: String(params?.[2]), mode: String(params?.[3]), source: String(params?.[4]), created_at: 'now', last_used_at: 'now' }] }; if (sql.startsWith('select id::text, canonical_path')) return { rows: [] }; return { rows: [] }; } } as unknown as import('pg').Pool;
}

test('native picker route persists selected folder and returns a stable grant', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'contentos-picker-route-')); const app = Fastify();
  registerLocalPathRoutes(app, { access: new LocalPathAccessService({ db: fakeDb(), desktopMode: true }), picker: { pickFolder: async () => ({ cancelled: false, path: folder }), pickFile: async () => ({ cancelled: true }) } });
  const response = await app.inject({ method: 'POST', url: '/api/v1/local-paths/pick-folder', payload: { purpose: 'MEDIA_ROOT' } });
  assert.equal(response.statusCode, 200); const body = response.json() as { cancelled: boolean; path: string; grantId: string; readable: boolean };
  assert.equal(body.cancelled, false); assert.equal(body.grantId, 'grant-1'); assert.equal(body.readable, true); await app.close();
});

test('native picker cancellation is not an error', async () => {
  const app = Fastify(); registerLocalPathRoutes(app, { access: new LocalPathAccessService({ db: fakeDb(), desktopMode: true }), picker: { pickFolder: async () => ({ cancelled: true }), pickFile: async () => ({ cancelled: true }) } });
  const response = await app.inject({ method: 'POST', url: '/api/v1/local-paths/pick-folder', payload: { purpose: 'OUTPUT_ROOT' } });
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { cancelled: true }); await app.close();
});
