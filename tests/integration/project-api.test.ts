import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

test('Project API creates, gets and lists ContentProjects with validation', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  await db.query("delete from content_projects where id like 'project-api-%'");
  const app = await buildApi(db);
  try {
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: {} });
    assert.equal(invalid.statusCode, 422);
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Vertical Slice Project', metadata: { seed: 1 } } });
    assert.equal(created.statusCode, 201);
    const project = created.json();
    assert.match(project.id, /^project-/);
    assert.equal(project.status, 'DRAFT');
    const fetched = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}` });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().id, project.id);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/projects' });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json().items.some((item: { id: string }) => item.id === project.id));
  } finally { await app.close(); await db.end(); }
});
