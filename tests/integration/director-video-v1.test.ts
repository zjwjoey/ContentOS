import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { DirectorV1Service } from '../../packages/modules/director/src/index.js';
import { VideoService, DirectorVideoService } from '../../packages/modules/video/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_director_dev';
const brief = { topic: '门店经营', targetPlatform: 'douyin', channelPositioning: '经营知识栏目', targetDurationSeconds: 30, contentType: 'knowledge', audience: '小微商家', coreThesis: '先验证，再扩大投入。', tone: '清晰', referenceMaterial: '访谈笔记', mustInclude: ['反例'], mustAvoid: ['夸大'], requirements: {}, createdBy: 'operator' };
const script = { origin: 'MANUAL' as const, title: '先验证再增长', titleCandidates: ['先验证再增长'], coverText: '先验证', topicKeywords: ['经营'], hook: '不要急着投入。', body: '先做小规模验证。', createdBy: 'editor' };
const scenes = [{ sceneIndex: 1, voiceoverText: '不要急着投入。', durationHintSeconds: 3, visualInstruction: '展示门店', assetKeywords: ['门店'] }];

test('approved Director V1 pair preserves provenance in the Video Job payload', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const project = await new ProjectService(db).create('Director Video V1'); const director = new DirectorV1Service(db); const video = new VideoService(db, new JobService(db)); const bridge = new DirectorVideoService(director, video);
  try {
    const createdBrief = await director.createBrief(project.id, brief); const aggregate = await director.createScript(project.id, createdBrief.id); const draft = await director.createScriptRevision(project.id, aggregate.id, script); const accepted = await director.acceptScript(project.id, draft.id); const board = await director.createStoryboard(project.id); const boardDraft = await director.createStoryboardRevision(project.id, board.id, { origin: 'MANUAL', scriptRevisionId: accepted.id, scenes, createdBy: 'editor' }); const approved = await director.approveStoryboard(project.id, boardDraft.id);
    const job = await bridge.createVideoJob(project.id, { videoAssetIds: ['asset-video-1'], targetDurationMs: 3_000 });
    const payload = job.payload as { videoAssetIds: string[]; metadata: { briefId: string; scriptRevisionId: string; storyboardRevisionId: string } };
    assert.deepEqual(payload.videoAssetIds, ['asset-video-1']); assert.equal(payload.metadata.briefId, createdBrief.id); assert.equal(payload.metadata.scriptRevisionId, accepted.id); assert.equal(payload.metadata.storyboardRevisionId, approved.id);
  } finally {
    await db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [project.id]); await db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [project.id]); await db.query('delete from jobs where project_id = $1', [project.id]); await db.query('delete from director_project_state where project_id = $1', [project.id]); await db.query('delete from director_storyboard_revisions where project_id = $1', [project.id]); await db.query('delete from director_storyboards where project_id = $1', [project.id]); await db.query('delete from director_script_revisions where project_id = $1', [project.id]); await db.query('delete from director_scripts where project_id = $1', [project.id]); await db.query('delete from director_briefs where project_id = $1', [project.id]); await db.query('delete from content_projects where id = $1', [project.id]); await db.end();
  }
});

test('Director V1 Video bridge rejects a draft or incomplete current pair', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const project = await new ProjectService(db).create('Director Video V1 Draft'); const director = new DirectorV1Service(db); const bridge = new DirectorVideoService(director, new VideoService(db, new JobService(db)));
  try {
    const createdBrief = await director.createBrief(project.id, brief); const aggregate = await director.createScript(project.id, createdBrief.id); await director.createScriptRevision(project.id, aggregate.id, script);
    await assert.rejects(() => bridge.createVideoJob(project.id, { videoAssetIds: ['asset-video-1'] }), /approved Script and Storyboard/);
  } finally {
    await db.query('delete from director_project_state where project_id = $1', [project.id]); await db.query('delete from director_script_revisions where project_id = $1', [project.id]); await db.query('delete from director_scripts where project_id = $1', [project.id]); await db.query('delete from director_briefs where project_id = $1', [project.id]); await db.query('delete from content_projects where id = $1', [project.id]); await db.end();
  }
});
