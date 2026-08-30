import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { DirectorV1Service } from '../../packages/modules/director/src/director-v1-service.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';

const briefInput = {
  topic: '门店经营中的一个常见误区', targetPlatform: 'douyin', channelPositioning: '面向小微商家的经营知识栏目',
  targetDurationSeconds: 45, contentType: 'knowledge', audience: '小微商家经营者', coreThesis: '先验证需求，再扩大投入。',
  tone: '清晰、克制、实用', ctaGoal: '引导观众收藏', referenceMaterial: '访谈笔记', mustInclude: ['一个反例'], mustAvoid: ['夸大承诺'], requirements: {}, createdBy: 'operator',
};

const scriptInput = {
  origin: 'AI' as const, title: '不要急着扩大投入', titleCandidates: ['不要急着扩大投入', '先验证，再增长'], coverText: '先验证，再增长',
  topicKeywords: ['经营', '验证需求'], hook: '很多人第一步就做错了。', body: '先用小成本验证真实需求，再决定是否扩大投入。', cta: '收藏这条建议。', createdBy: 'director-worker',
};

const storyboardInput = {
  origin: 'AI' as const, scenes: [
    { sceneIndex: 1, voiceoverText: '很多人第一步就做错了。', durationHintSeconds: 3, visualInstruction: '人物面对账本犹豫', assetKeywords: ['账本'] },
    { sceneIndex: 2, voiceoverText: '先验证真实需求，再扩大投入。', durationHintSeconds: 5, visualInstruction: '展示小规模测试', assetKeywords: ['测试', '门店'] },
  ], createdBy: 'director-worker',
};

test('Director V1 keeps append-only revisions and an approved current pair', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Director V1 Integration');
  const director = new DirectorV1Service(db);
  try {
    const brief = await director.createBrief(project.id, briefInput);
    assert.equal(brief.revision, 1);
    const script = await director.createScript(project.id, brief.id);
    const draft = await director.createScriptRevision(project.id, script.id, scriptInput);
    assert.equal(draft.revision, 1); assert.equal(draft.status, 'DRAFT');
    const accepted = await director.acceptScript(project.id, draft.id);
    assert.equal(accepted.status, 'ACCEPTED');
    const storyboard = await director.createStoryboard(project.id);
    const storyboardDraft = await director.createStoryboardRevision(project.id, storyboard.id, { ...storyboardInput, scriptRevisionId: accepted.id });
    const approved = await director.approveStoryboard(project.id, storyboardDraft.id);
    assert.equal(approved.status, 'APPROVED');
    const current = await director.getCurrentPair(project.id);
    assert.equal(current.brief?.id, brief.id); assert.equal(current.script?.id, accepted.id); assert.equal(current.storyboard?.id, approved.id);
  } finally {
    await db.query('delete from director_project_state where project_id = $1', [project.id]);
    await db.query('delete from director_storyboard_revisions where project_id = $1', [project.id]);
    await db.query('delete from director_storyboards where project_id = $1', [project.id]);
    await db.query('delete from director_script_revisions where project_id = $1', [project.id]);
    await db.query('delete from director_scripts where project_id = $1', [project.id]);
    await db.query('delete from director_briefs where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]); await db.end();
  }
});

test('Director V1 manual revisions link to parent and accepting a new script clears storyboard', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Director V1 Manual');
  const director = new DirectorV1Service(db);
  try {
    const brief = await director.createBrief(project.id, briefInput);
    const script = await director.createScript(project.id, brief.id);
    const first = await director.createScriptRevision(project.id, script.id, scriptInput);
    const accepted = await director.acceptScript(project.id, first.id);
    const board = await director.createStoryboard(project.id);
    const boardDraft = await director.createStoryboardRevision(project.id, board.id, { ...storyboardInput, scriptRevisionId: accepted.id });
    await director.approveStoryboard(project.id, boardDraft.id);
    const manual = await director.createManualScriptRevision(project.id, accepted.id, { ...scriptInput, origin: 'MANUAL', body: '先做低成本测试，再决定投入规模。' }, 'editor');
    assert.equal(manual.parentRevisionId, accepted.id); assert.equal(manual.origin, 'MANUAL'); assert.equal(manual.revision, 2);
    await director.acceptScript(project.id, manual.id);
    const current = await director.getCurrentPair(project.id);
    assert.equal(current.script?.id, manual.id); assert.equal(current.storyboard, null);
    await assert.rejects(() => director.approveStoryboard(project.id, boardDraft.id), /must be DRAFT/);
  } finally {
    await db.query('delete from director_project_state where project_id = $1', [project.id]);
    await db.query('delete from director_storyboard_revisions where project_id = $1', [project.id]);
    await db.query('delete from director_storyboards where project_id = $1', [project.id]);
    await db.query('delete from director_script_revisions where project_id = $1', [project.id]);
    await db.query('delete from director_scripts where project_id = $1', [project.id]);
    await db.query('delete from director_briefs where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]); await db.end();
  }
});

test('Director V1 rejects a storyboard bound to a draft or mismatched Script revision', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Director V1 Mismatch');
  const director = new DirectorV1Service(db);
  try {
    const brief = await director.createBrief(project.id, briefInput);
    const script = await director.createScript(project.id, brief.id);
    const draft = await director.createScriptRevision(project.id, script.id, scriptInput);
    const board = await director.createStoryboard(project.id);
    await assert.rejects(() => director.createStoryboardRevision(project.id, board.id, { ...storyboardInput, scriptRevisionId: draft.id }), /accepted source Script/);
  } finally {
    await db.query('delete from director_project_state where project_id = $1', [project.id]);
    await db.query('delete from director_storyboard_revisions where project_id = $1', [project.id]);
    await db.query('delete from director_storyboards where project_id = $1', [project.id]);
    await db.query('delete from director_script_revisions where project_id = $1', [project.id]);
    await db.query('delete from director_scripts where project_id = $1', [project.id]);
    await db.query('delete from director_briefs where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]); await db.end();
  }
});
