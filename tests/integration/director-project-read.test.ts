import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { DirectorService, DirectorV1Service, DirectorProjectReadService } from '../../packages/modules/director/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';
const brief = { topic: '测试主题', targetPlatform: 'douyin', channelPositioning: '知识栏目', targetDurationSeconds: 30, contentType: 'knowledge', audience: '运营人员', coreThesis: '先验证', tone: '清晰', referenceMaterial: '材料', mustInclude: ['反例'], mustAvoid: ['夸大'], requirements: {}, createdBy: 'operator' };
const script = { origin: 'MANUAL' as const, title: '测试脚本', titleCandidates: ['测试脚本'], coverText: '测试', topicKeywords: ['测试'], hook: '开头', body: '正文', cta: '行动', createdBy: 'operator' };
const storyboard = { origin: 'MANUAL' as const, scenes: [{ sceneIndex: 1, voiceoverText: '旁白', durationHintSeconds: 2, visualInstruction: '画面', assetKeywords: ['测试'] }], createdBy: 'operator' };

test('Director project read service exposes V1 current targets and approval readiness', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Director project read ' + Date.now());
  const v1 = new DirectorV1Service(db);
  const legacy = new DirectorService(db, new ProjectService(db));
  const reader = new DirectorProjectReadService(v1, legacy);
  try {
    const createdBrief = await v1.createBrief(project.id, brief);
    const scriptAggregate = await v1.createScript(project.id, createdBrief.id);
    const scriptDraft = await v1.createScriptRevision(project.id, scriptAggregate.id, script);
    await v1.acceptScript(project.id, scriptDraft.id);
    const storyboardAggregate = await v1.createStoryboard(project.id);
    const storyboardDraft = await v1.createStoryboardRevision(project.id, storyboardAggregate.id, { ...storyboard, scriptRevisionId: scriptDraft.id });
    await v1.approveStoryboard(project.id, storyboardDraft.id);
    const summary = await reader.get(project.id);
    assert.equal(summary.source, 'V1');
    assert.equal(summary.readyForVideo, true);
    assert.deepEqual(summary.activeScript, { aggregateId: scriptAggregate.id, revisionId: scriptDraft.id });
    assert.deepEqual(summary.activeStoryboard, { aggregateId: storyboardAggregate.id, revisionId: storyboardDraft.id });
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
