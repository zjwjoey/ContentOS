import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test';

test('video presets persist, become default, and are remembered by a project', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const app = await buildApi({ db }); const name = `验收模板 ${randomUUID()}`; let projectId = '';
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: `模板验收项目 ${randomUUID()}` } }); assert.equal(project.statusCode, 201); projectId = project.json().id;
    const listed = await app.inject({ method: 'GET', url: '/api/v1/video/presets' }); assert.equal(listed.statusCode, 200); assert.ok(listed.json().items.some((item: { name: string }) => item.name === 'MIZAN 门店口播'));
    const created = await app.inject({ method: 'POST', url: '/api/v1/video/presets', payload: { name, description: '测试模板', editModeDefault: 'RANDOM', minClipDurationMs: 1800, maxClipDurationMs: 4200, preferUnusedMedia: true } }); assert.equal(created.statusCode, 201); const presetId = created.json().id;
    const updated = await app.inject({ method: 'PATCH', url: `/api/v1/video/presets/${presetId}`, payload: { description: '已更新模板' } }); assert.equal(updated.statusCode, 200); assert.equal(updated.json().description, '已更新模板');
    const defaulted = await app.inject({ method: 'POST', url: `/api/v1/video/presets/${presetId}/default` }); assert.equal(defaulted.statusCode, 200); assert.equal(defaulted.json().isDefault, true);
    const applied = await app.inject({ method: 'PUT', url: `/api/v1/projects/${projectId}/video/preset`, payload: { presetId } }); assert.equal(applied.statusCode, 200); const current = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/video/preset` }); assert.equal(current.statusCode, 200); assert.equal(current.json().preset.id, presetId);
    const deletedDefault = await app.inject({ method: 'DELETE', url: `/api/v1/video/presets/${presetId}` }); assert.equal(deletedDefault.statusCode, 409);
    const removedDefault = await app.inject({ method: 'POST', url: '/api/v1/video/presets/preset-mizan-store/default' }); assert.equal(removedDefault.statusCode, 200); const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/video/presets/${presetId}` }); assert.equal(deleted.statusCode, 200);
  } finally { if (projectId) await db.query('delete from content_projects where id = $1', [projectId]); await app.close(); await db.end(); }
});
