import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { DirectorV1Service } from '../../packages/modules/director/src/index.js';
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

test('Director to Video API creates a Video Job from the current Director V1 pair', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Director V1 Video API'); const app = await buildApi(db); const director = new DirectorV1Service(db);
  try {
    const brief = await director.createBrief(project.id, { topic: '主题', targetPlatform: 'douyin', channelPositioning: '栏目', targetDurationSeconds: 30, contentType: 'knowledge', audience: '运营', coreThesis: '先验证', tone: '清晰', referenceMaterial: '材料', mustInclude: ['反例'], mustAvoid: ['夸大'], requirements: {}, createdBy: 'operator' });
    const scriptAggregate = await director.createScript(project.id, brief.id);
    const script = await director.createScriptRevision(project.id, scriptAggregate.id, { origin: 'MANUAL', title: '脚本', titleCandidates: ['脚本'], coverText: '封面', topicKeywords: ['主题'], hook: '开头', body: '正文', createdBy: 'operator' });
    const accepted = await director.acceptScript(project.id, script.id);
    const storyboardAggregate = await director.createStoryboard(project.id);
    const storyboard = await director.createStoryboardRevision(project.id, storyboardAggregate.id, { origin: 'MANUAL', scriptRevisionId: accepted.id, scenes: [{ sceneIndex: 1, voiceoverText: '旁白', durationHintSeconds: 2, visualInstruction: '画面', assetKeywords: ['主题'] }], createdBy: 'operator' });
    await director.approveStoryboard(project.id, storyboard.id);
    const response = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/video-jobs/from-director`, payload: { videoAssetIds: ['asset-v1-source'], targetDurationMs: 2000 } });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().type, 'VIDEO_RENDER');
  } finally {
    await app.close();
    await db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [project.id]);
    await db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [project.id]);
    await db.query('delete from jobs where project_id = $1', [project.id]);
    await db.query('delete from director_project_state where project_id = $1', [project.id]);
    await db.query('delete from director_storyboard_revisions where project_id = $1', [project.id]);
    await db.query('delete from director_storyboards where project_id = $1', [project.id]);
    await db.query('delete from director_script_revisions where project_id = $1', [project.id]);
    await db.query('delete from director_scripts where project_id = $1', [project.id]);
    await db.query('delete from director_briefs where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]); await db.end();
  }
});
