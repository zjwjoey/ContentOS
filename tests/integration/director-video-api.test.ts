import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';
const plan = { seed: 9, brief: { topic: '收纳', audience: '家庭', objective: '给出建议', tone: '实用' }, storyboard: [{ id: 'scene-1', title: '开场', narration: '开始', visualIntent: '俯拍', durationMs: 1200, sourceAssetIds: ['asset-video-bridge'] }], provenance: { author: 'zjwjoey', source: 'manual' } };

test('Director to Video API creates an idempotent VIDEO_RENDER Job from approval', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Director Video API'); const app = await buildApi(db);
  try {
    const draft = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/director-plans`, payload: plan });
    const revision = draft.json().revision as number;
    await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/director-plans/${revision}/accept` });
    await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/director-plans/${revision}/approve` });
    const first = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/video-jobs/from-director`, payload: { targetDurationMs: 1200 } });
    assert.equal(first.statusCode, 201); assert.equal(first.json().type, 'VIDEO_RENDER');
    const second = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/video-jobs/from-director`, payload: { targetDurationMs: 1200 } });
    assert.equal(second.statusCode, 201); assert.equal(second.json().id, first.json().id);
  } finally {
    await app.close();
    await db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [project.id]);
    await db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [project.id]);
    await db.query('delete from jobs where project_id = $1', [project.id]);
    await db.query('update content_projects set current_director_revision_id = null where id = $1', [project.id]);
    await db.query('delete from director_plan_revisions where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]); await db.end();
  }
});

test('Director to Video API rejects a project without an approved plan', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('No Director Approval'); const app = await buildApi(db);
  try { const response = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/video-jobs/from-director`, payload: {} }); assert.equal(response.statusCode, 409); }
  finally { await app.close(); await db.query('delete from content_projects where id = $1', [project.id]); await db.end(); }
});
