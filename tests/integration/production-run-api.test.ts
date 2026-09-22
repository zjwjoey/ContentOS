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

test('Production Run public step API rejects terminal success claims and validates generate ownership before side effects', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const app = await buildApi(db); let projectId = '';
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: `Production adversarial ${Date.now()}` } }); projectId = project.json().id as string;
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs`, payload: { title: 'Adversarial' } }); const run = created.json();
    for (const stage of ['APPROVAL', 'RENDER']) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs/${run.id}/steps/${stage}`, payload: { status: 'SUCCEEDED', outputRefs: {} } });
      assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'PRODUCTION_TERMINAL_TRANSITION_FORBIDDEN');
    }
    const workspaceId = `workspace-project-${projectId}`;
    await db.query("insert into video_workspaces (id,type,project_id) values ($1,'PROJECT',$2) on conflict (id) do nothing", [workspaceId, projectId]);
    const before = await db.query('select count(*)::int as count from edit_manifests where workspace_id=$1', [workspaceId]);
    await db.query("update production_run_steps set status='RUNNING',output_refs=$2::jsonb where production_run_id=$1 and stage='EDITING'", [run.id, JSON.stringify({ editSessionId: 'session-owned-by-run' })]);
    const wrongSession = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs/${run.id}/editing-session/wrong-session/generate`, payload: {} });
    assert.equal(wrongSession.statusCode, 409); assert.equal(wrongSession.json().error.code, 'PRODUCTION_EDIT_SESSION_MISMATCH');
    const after = await db.query('select count(*)::int as count from edit_manifests where workspace_id=$1', [workspaceId]); assert.equal(after.rows[0].count, before.rows[0].count);
  } finally { if (projectId) await db.query('delete from content_projects where id=$1', [projectId]); await app.close?.().catch(() => undefined); await db.end(); }
});
