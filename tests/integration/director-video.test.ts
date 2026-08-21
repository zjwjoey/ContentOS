import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { DirectorService } from '../../packages/modules/director/src/index.js';
import { VideoService } from '../../packages/modules/video/src/index.js';
import { DirectorVideoService } from '../../packages/modules/video/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import type { DirectorPlanV0 } from '../../packages/contracts/src/index.js';
import type { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';
const basePlan: DirectorPlanV0 = {
  schemaVersion: 'DIRECTOR_PLAN_V0', projectId: 'pending', seed: 11,
  brief: { topic: '桌面整理', audience: '远程办公者', objective: '给出可执行步骤', tone: '实用' },
  storyboard: [{ id: 'scene-1', title: '开场', narration: '先清空桌面', visualIntent: '桌面俯拍', durationMs: 1600, sourceAssetIds: ['asset-video-1'] }],
  provenance: { author: 'zjwjoey', source: 'manual' },
};

async function approve(db: Pool, projectId: string, plan: DirectorPlanV0) {
  const director = new DirectorService(db);
  const draft = await director.createDraft(projectId, { ...plan, projectId });
  await director.accept(projectId, draft.revision);
  return director.approveStoryboard(projectId, draft.revision);
}

test('approved Director revision creates one idempotent Video Job', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const projects = new ProjectService(db); const project = await projects.create('Director to Video');
  const plan = await approve(db, project.id, basePlan);
  const video = new VideoService(db, new JobService(db));
  const bridge = new DirectorVideoService(new DirectorService(db), video);
  try {
    const first = await bridge.createVideoJob(project.id, { targetDurationMs: 1600 });
    const second = await bridge.createVideoJob(project.id, { targetDurationMs: 1600 });
    assert.equal(first.id, second.id);
    assert.equal(first.type, 'VIDEO_RENDER');
    const payload = first.payload as { directorRevisionId: string; videoAssetIds: string[]; directorStoryboard: unknown[] };
    assert.equal(payload.directorRevisionId, plan.id); assert.deepEqual(payload.videoAssetIds, ['asset-video-1']); assert.equal(payload.directorStoryboard.length, 1);
  } finally {
    await db.query('delete from job_events where project_id = $1', [project.id]).catch(() => undefined);
    await db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [project.id]);
    await db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [project.id]);
    await db.query('delete from jobs where project_id = $1', [project.id]);
    await db.query('update content_projects set current_director_revision_id = null where id = $1', [project.id]);
    await db.query('delete from director_plan_revisions where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]); await db.end();
  }
});

test('Director to Video bridge rejects projects without an approved revision', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Unapproved Director');
  const director = new DirectorService(db); await director.createDraft(project.id, { ...basePlan, projectId: project.id });
  const bridge = new DirectorVideoService(director, new VideoService(db, new JobService(db)));
  try { await assert.rejects(() => bridge.createVideoJob(project.id, { targetDurationMs: 1600 }), /approved Director revision/); }
  finally { await db.query('delete from director_plan_revisions where project_id = $1', [project.id]); await db.query('delete from content_projects where id = $1', [project.id]); await db.end(); }
});
