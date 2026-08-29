import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApi } from '../../apps/api/src/app.js';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';

function multipart(filename: string, contentType: string, content: string): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----contentos-${randomUUID()}`;
  return { body: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n${content}\r\n--${boundary}--\r\n`), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

test('Standalone Quick Edit API exposes no-project create, plan and render flow', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const app = await buildApi(db); const suffix = randomUUID(); const assetIds = [`api-standalone-a-${suffix}`, `api-standalone-b-${suffix}`]; const voiceId = `api-standalone-voice-${suffix}`; let workspaceId = '';
  try {
    for (const id of assetIds) await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, null, $2, $3, $4, $5, $6, $7)', [id, 'VIDEO', `sha256:${id}`, 100, `standalone/${id}.mp4`, 'READY', { durationMs: 8_000 }]);
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, null, $2, $3, $4, $5, $6, $7)', [voiceId, 'AUDIO', `sha256:${voiceId}`, 100, `standalone/${voiceId}.wav`, 'READY', { durationMs: 10_000 }]);
    const created = await app.inject({ method: 'POST', url: '/api/v1/video/quick-edits', payload: { sourceAssetIds: assetIds, voiceAssetId: voiceId, seed: 7 } });
    assert.equal(created.statusCode, 201, created.body); const session = JSON.parse(created.body) as { id: string; workspaceId: string }; workspaceId = session.workspaceId;
    assert.equal((await db.query('select count(*)::int as count from content_projects where id = $1', [workspaceId])).rows[0]?.count, 0);
    const planned = await app.inject({ method: 'POST', url: `/api/v1/video/quick-edits/${session.id}/plan`, payload: {} }); assert.equal(planned.statusCode, 201, planned.body); const manifest = JSON.parse(planned.body) as { id: string; revision: number; projectId: string; workspaceId: string }; assert.equal(manifest.projectId, ''); assert.equal(manifest.workspaceId, workspaceId);
    const listed = await app.inject({ method: 'GET', url: `/api/v1/video/quick-edits/${session.id}/manifests` }); assert.equal(listed.statusCode, 200); assert.equal(JSON.parse(listed.body).items.length, 1);
    const rendered = await app.inject({ method: 'POST', url: `/api/v1/video/quick-edits/${session.id}/render`, payload: {} }); assert.equal(rendered.statusCode, 201, rendered.body); const job = JSON.parse(rendered.body) as { projectId: string | null; workspaceId: string }; assert.equal(job.projectId, null); assert.equal(job.workspaceId, workspaceId);
  } finally {
    if (workspaceId) { await db.query('delete from renders where workspace_id = $1', [workspaceId]); await db.query('update video_quick_edit_sessions set current_manifest_id = null where workspace_id = $1', [workspaceId]); await db.query('delete from edit_manifests where workspace_id = $1', [workspaceId]); await db.query('delete from jobs where workspace_id = $1', [workspaceId]); await db.query('delete from video_quick_edit_sessions where workspace_id = $1', [workspaceId]); await db.query('delete from video_workspace_assets where workspace_id = $1', [workspaceId]); await db.query('delete from video_workspaces where id = $1', [workspaceId]); }
    await db.query('delete from assets where id = any($1::text[])', [assetIds.concat(voiceId)]); await app.close(); await db.end();
  }
});

test('Standalone Quick Edit accepts workspace-scoped uploads without creating a Project', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const app = await buildApi(db); let workspaceId = ''; let sessionId = '';
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/video/quick-edits', payload: { sourceAssetIds: [], targetDurationMs: 4_000, seed: 3 } });
    assert.equal(created.statusCode, 201, created.body); const session = created.json() as { id: string; workspaceId: string }; sessionId = session.id; workspaceId = session.workspaceId;
    const upload = await app.inject({ method: 'POST', url: `/api/v1/video/quick-edits/${sessionId}/assets`, ...multipart('clip.mp4', 'video/mp4', 'queued-bytes') });
    assert.equal(upload.statusCode, 202, upload.body); assert.equal(upload.json().import.workspaceId, workspaceId); assert.equal(upload.json().import.projectId, '');
    const listed = await app.inject({ method: 'GET', url: `/api/v1/video/quick-edits/${sessionId}/assets` });
    assert.equal(listed.statusCode, 200); assert.equal(listed.json().imports.length, 1);
    assert.equal((await db.query('select count(*)::int as count from content_projects where id = $1', [workspaceId])).rows[0]?.count, 0);
  } finally {
    if (workspaceId) { await db.query('delete from asset_imports where workspace_id = $1', [workspaceId]); await db.query('delete from jobs where workspace_id = $1', [workspaceId]); await db.query('delete from video_quick_edit_sessions where workspace_id = $1', [workspaceId]); await db.query('delete from video_workspace_assets where workspace_id = $1', [workspaceId]); await db.query('delete from video_workspaces where id = $1', [workspaceId]); }
    await app.close(); await db.end();
  }
});
