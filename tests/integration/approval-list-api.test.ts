import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:5432/contentos_test';

test('Approval list returns only the current decision for each exact target', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Approval list ' + randomUUID());
  const app = await buildApi(db);
  try {
    const render = { targetType: 'RENDER', targetId: 'render-' + randomUUID(), targetRevisionId: 'asset-' + randomUUID() };
    const publish = { targetType: 'PUBLISH', targetId: 'request-' + randomUUID(), targetRevisionId: 'publish-revision-' + randomUUID() };
    for (const target of [render, publish]) {
      const first = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/approvals`, payload: { ...target, status: 'PENDING', approver: 'operator' } });
      assert.equal(first.statusCode, 201, first.body);
    }
    const current = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/approvals` });
    assert.equal(current.statusCode, 200);
    assert.equal(current.json().items.length, 2);
    assert.deepEqual(current.json().items.map((item: { targetType: string }) => item.targetType), ['PUBLISH', 'RENDER']);
    assert.equal(current.json().items[0].targetRevisionId, publish.targetRevisionId);
    assert.doesNotMatch(current.body, /storageKey|sourcePath|accessToken|cookie|authorization/i);
  } finally {
    await app.close();
    await db.query('delete from approval_decisions where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end();
  }
});
