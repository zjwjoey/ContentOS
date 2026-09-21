import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

test('Jianying draft picker routes accept both a file and a directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-jianying-picker-route-')); const file = join(root, 'draft_content.json'); const directory = join(root, 'draft'); await mkdir(directory); await writeFile(file, '{}');
  try {
    const fileApp = Fastify(); registerLocalPathRoutes(fileApp, { access: new LocalPathAccessService({ db: fakeDb(), desktopMode: true }), picker: { pickFolder: async () => ({ cancelled: true }), pickFile: async () => ({ cancelled: false, path: file }) } });
    const fileResponse = await fileApp.inject({ method: 'POST', url: '/api/v1/local-paths/pick-file', payload: { purpose: 'JIANYING_DRAFT' } });
    assert.equal(fileResponse.statusCode, 200); assert.equal((fileResponse.json() as { kind: string }).kind, 'JIANYING_DRAFT'); await fileApp.close();
    const directoryApp = Fastify(); registerLocalPathRoutes(directoryApp, { access: new LocalPathAccessService({ db: fakeDb(), desktopMode: true }), picker: { pickFolder: async () => ({ cancelled: false, path: directory }), pickFile: async () => ({ cancelled: true }) } });
    const directoryResponse = await directoryApp.inject({ method: 'POST', url: '/api/v1/local-paths/pick-folder', payload: { purpose: 'JIANYING_DRAFT' } });
    assert.equal(directoryResponse.statusCode, 200); assert.equal((directoryResponse.json() as { kind: string }).kind, 'JIANYING_DRAFT'); await directoryApp.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
