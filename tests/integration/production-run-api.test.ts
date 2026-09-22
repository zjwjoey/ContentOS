import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test';

test('Production Run API exposes durable creation, detail and guarded handoff endpoints', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const app = await buildApi(db);
  let projectId = '';
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: `Production API ${Date.now()}` } }); assert.equal(project.statusCode, 201); projectId = project.json().id as string;
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs`, payload: { title: 'API 闭环', idempotencyKey: 'api-same-click' } }); assert.equal(created.statusCode, 201); const run = created.json();
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs`, payload: { title: '不同标题', idempotencyKey: 'api-same-click' } }); assert.equal(duplicate.statusCode, 201); assert.equal(duplicate.json().id, run.id);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/production-runs/${run.id}` }); assert.equal(detail.statusCode, 200); assert.equal(detail.json().steps.length, 10);
    const guarded = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs/${run.id}/handoff/DIGITAL_HUMAN`, payload: { outputRefs: {}, status: 'SKIPPED' } }); assert.equal(guarded.statusCode, 409); assert.match(guarded.json().error.code, /PREVIOUS_STAGE_NOT_READY/);
  } finally { if (projectId) await db.query('delete from content_projects where id=$1', [projectId]); await app.close?.().catch(() => undefined); await db.end(); }
});
