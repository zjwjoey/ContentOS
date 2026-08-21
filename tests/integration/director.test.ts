import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateDown, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { DirectorService } from '../../packages/modules/director/src/index.js';
import type { DirectorPlanV0 } from '../../packages/contracts/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';
const plan: DirectorPlanV0 = {
  schemaVersion: 'DIRECTOR_PLAN_V0', projectId: 'pending', seed: 17,
  brief: { topic: '冬季收纳', audience: '小户型家庭', objective: '给出三个可执行建议', tone: '清晰、实用' },
  storyboard: [{ id: 'scene-1', title: '开场', narration: '先整理高频物品', visualIntent: '俯拍收纳盒', durationMs: 2200, sourceAssetIds: [] }],
  provenance: { author: 'zjwjoey', source: 'manual' },
};

test('Director keeps append-only revisions and approved current pointer', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create('Director Integration');
  const director = new DirectorService(db);
  try {
    const first = await director.createDraft(project.id, { ...plan, projectId: project.id });
    assert.equal(first.revision, 1); assert.equal(first.status, 'DRAFT');
    const accepted = await director.accept(project.id, first.revision);
    assert.equal(accepted.status, 'ACCEPTED');
    const approved = await director.approveStoryboard(project.id, first.revision);
    assert.equal(approved.status, 'APPROVED');
    assert.equal((await director.getCurrent(project.id))?.revision, 1);
    const revised = await director.revise(project.id, first.revision, { ...plan, projectId: project.id, seed: 18, brief: { ...plan.brief, objective: '给出四个可执行建议' } });
    assert.equal(revised.revision, 2); assert.equal(revised.status, 'DRAFT');
    assert.equal((await director.list(project.id)).length, 2);
    await assert.rejects(() => director.approveStoryboard(project.id, revised.revision), /must be ACCEPTED/);
  } finally {
    await db.query('update content_projects set current_director_revision_id = null where id = $1', [project.id]);
    await db.query('delete from director_plan_revisions where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end();
  }
});

test('Director migration down/up preserves a clean migration boundary', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  await migrateDown(db);
  await migrateUp(db);
  const table = await db.query<{ exists: string }>("select to_regclass('public.director_plan_revisions')::text as exists");
  assert.equal(table.rows[0]?.exists, 'director_plan_revisions');
  await db.end();
});
