import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';
const payload = { seed: 3, brief: { topic: '厨房整理', audience: '租房用户', objective: '降低整理门槛', tone: '简洁' }, storyboard: [{ id: 'scene-1', title: '开场', narration: '先清空台面', visualIntent: '厨房台面俯拍', durationMs: 1800, sourceAssetIds: [] }], provenance: { author: 'zjwjoey', source: 'manual' } };

test('Director API creates, accepts, approves and revises project plans', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create('Director API');
  const app = await buildApi(db);
  try {
    const invalid = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/director-plans`, payload: { ...payload, brief: { ...payload.brief, topic: '' } } });
    assert.equal(invalid.statusCode, 422);
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/director-plans`, payload });
    assert.equal(created.statusCode, 201); assert.equal(created.json().status, 'DRAFT');
    const revision = created.json().revision as number;
    const premature = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/director-plans/${revision}/approve` });
    assert.equal(premature.statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/director-plans/${revision}/accept` })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/director-plans/${revision}/approve` })).statusCode, 200);
    const current = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/director-plans/current` });
    assert.equal(current.statusCode, 200); assert.equal(current.json().revision, revision);
    const revised = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/director-plans/${revision}/revise`, payload: { ...payload, seed: 4 } });
    assert.equal(revised.statusCode, 201); assert.equal(revised.json().revision, 2);
  } finally {
    await app.close();
    await db.query('update content_projects set current_director_revision_id = null where id = $1', [project.id]);
    await db.query('delete from director_plan_revisions where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end();
  }
});
