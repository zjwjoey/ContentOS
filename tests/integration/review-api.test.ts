import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

test('Review API creates, approves and rejects decisions with guarded transitions', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create('Review API');
  const app = await buildApi(db);
  try {
    const invalid = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/reviews`, payload: { targetType: 'BAD', targetId: '', status: 'PENDING', reviewer: '' } });
    assert.equal(invalid.statusCode, 422);
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/reviews`, payload: { targetType: 'RENDER', targetId: 'render-api', status: 'PENDING', reviewer: 'operator' } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().status, 'PENDING');
    const target = `/api/v1/projects/${project.id}/reviews/RENDER/render-api`;
    assert.equal((await app.inject({ method: 'GET', url: `${target}/current` })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `${target}/approve`, payload: { reviewer: 'lead' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `${target}/approve`, payload: { reviewer: 'lead' } })).statusCode, 409);

    const rejected = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/reviews`, payload: { targetType: 'PUBLISH', targetId: 'publish-api', status: 'PENDING', reviewer: 'operator' } });
    assert.equal(rejected.statusCode, 201);
    const rejectUrl = `/api/v1/projects/${project.id}/reviews/PUBLISH/publish-api/reject`;
    assert.equal((await app.inject({ method: 'POST', url: rejectUrl, payload: { reviewer: 'lead' } })).statusCode, 422);
    const result = await app.inject({ method: 'POST', url: rejectUrl, payload: { reviewer: 'lead', reason: 'Needs evidence' } });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().status, 'REJECTED');
  } finally {
    await app.close();
    await db.query('delete from review_decisions where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end();
  }
});
