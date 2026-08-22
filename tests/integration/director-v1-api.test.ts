import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_director_dev';
const brief = { topic: '门店经营', targetPlatform: 'douyin', channelPositioning: '经营知识栏目', targetDurationSeconds: 45, contentType: 'knowledge', audience: '小微商家', coreThesis: '先验证，再扩大投入。', tone: '清晰、克制', ctaGoal: '引导收藏', referenceMaterial: '访谈笔记', mustInclude: ['反例'], mustAvoid: ['夸大承诺'], requirements: {}, createdBy: 'operator' };
const script = { origin: 'MANUAL', title: '先验证再增长', titleCandidates: ['先验证再增长'], coverText: '先验证', topicKeywords: ['经营'], hook: '不要急着投入。', body: '先做小规模验证。', cta: '收藏建议。', createdBy: 'editor' };

test('Director V1 API creates briefs, queues jobs, preserves revisions and returns safe job status', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const project = await new ProjectService(db).create('Director V1 API'); const app = await buildApi(db);
  try {
    const invalid = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/director/brief`, payload: { ...brief, apiKey: 'must-not-be-accepted' } }); assert.equal(invalid.statusCode, 422);
    const createdBrief = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/director/brief`, payload: brief }); assert.equal(createdBrief.statusCode, 201); const briefId = createdBrief.json().id as string;
    const queued = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/scripts/generate`, payload: { briefId, correlationId: 'corr-api-script' } }); assert.equal(queued.statusCode, 202); const queuedJson = queued.json(); assert.equal(queuedJson.state, 'QUEUED'); assert.equal(typeof queuedJson.jobId, 'string'); assert.equal(typeof queuedJson.scriptAggregateId, 'string');
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/scripts` })).json().items, []);
    const job = await app.inject({ method: 'GET', url: `/api/v1/jobs/${queuedJson.jobId}` }); assert.equal(job.statusCode, 200); assert.equal(job.json().payload, undefined); assert.equal(job.json().state, 'QUEUED');
    const revision = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/scripts/${queuedJson.scriptAggregateId}/revisions`, payload: script }); assert.equal(revision.statusCode, 201); const revisionId = revision.json().id as string;
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/scripts/${revisionId}/accept` })).statusCode, 200);
    const boardJob = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/scripts/${revisionId}/storyboards/generate`, payload: { correlationId: 'corr-api-storyboard' } }); assert.equal(boardJob.statusCode, 202); assert.equal(boardJob.json().state, 'QUEUED');
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/storyboards` })).statusCode, 200);
  } finally {
    await app.close();
    await db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [project.id]); await db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [project.id]); await db.query('delete from jobs where project_id = $1', [project.id]);
    await db.query('delete from director_project_state where project_id = $1', [project.id]); await db.query('delete from director_storyboard_revisions where project_id = $1', [project.id]); await db.query('delete from director_storyboards where project_id = $1', [project.id]); await db.query('delete from director_script_revisions where project_id = $1', [project.id]); await db.query('delete from director_scripts where project_id = $1', [project.id]); await db.query('delete from director_briefs where project_id = $1', [project.id]); await db.query('delete from content_projects where id = $1', [project.id]); await db.end();
  }
});

test('Director V1 API distinguishes Brief validation from missing projects', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const project = await new ProjectService(db).create('Director V1 API Errors'); const app = await buildApi(db);
  try {
    const invalidBrief = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/director/brief`, payload: { ...brief, mustInclude: [], mustAvoid: [] } });
    assert.equal(invalidBrief.statusCode, 422);
    assert.equal(invalidBrief.json().error.code, 'DIRECTOR_VALIDATION_ERROR');
    const missingProject = await app.inject({ method: 'POST', url: '/api/v1/projects/project-does-not-exist/director/brief', payload: brief });
    assert.equal(missingProject.statusCode, 404);
    assert.equal(missingProject.json().error.code, 'DIRECTOR_PROJECT_NOT_FOUND');
  } finally {
    await app.close();
    await db.query('delete from content_projects where id = $1', [project.id]); await db.end();
  }
});
