import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { ProductionRunService } from '../../packages/modules/production-run/src/index.js';
import { DirectorV1Service } from '../../packages/modules/director/src/index.js';
import { ScriptEditingV3Service } from '../../packages/modules/video/src/index.js';
import { generateFixtureVideo } from '../../packages/infrastructure/ffmpeg/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test';

test('production run is durable, resumable, idempotent, retryable and cancellable', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create(`Production ${randomUUID()}`);
  try {
    const service = new ProductionRunService(db);
    const first = await service.create({ projectId: project.id, title: '闭环短视频', digitalHumanMode: 'NONE', idempotencyKey: 'same-click' });
    assert.equal(first.steps.length, 10); assert.equal(first.steps.find((step) => step.stage === 'DIGITAL_HUMAN')?.status, 'SKIPPED');
    const duplicate = await service.create({ projectId: project.id, title: '不应重复', idempotencyKey: 'same-click' }); assert.equal(duplicate.id, first.id);
    const running = await service.updateStep(project.id, first.id, { stage: 'CONTENT', status: 'RUNNING', outputRefs: { contentId: 'content-1' } }); assert.equal(running.status, 'RUNNING');
    const failed = await service.updateStep(project.id, first.id, { stage: 'CONTENT', status: 'FAILED', errorCode: 'DOMAIN_JOB_FAILED', errorMessage: 'temporary' }); assert.equal(failed.status, 'FAILED');
    const retried = await service.retry(project.id, first.id, 'CONTENT'); assert.equal(retried.steps[0]?.status, 'PENDING');
    await service.updateStep(project.id, first.id, { stage: 'CONTENT', status: 'SUCCEEDED', outputRefs: { contentId: 'content-1' } });
    const reloaded = new ProductionRunService(db); const resumed = await reloaded.get(project.id, first.id); assert.equal(resumed?.trace.contentId, 'content-1');
    const cancelled = await reloaded.cancel(project.id, first.id); assert.equal(cancelled.status, 'CANCELLED'); assert.ok(cancelled.steps.every((step) => ['SUCCEEDED', 'SKIPPED', 'CANCELLED'].includes(step.status)));
  } finally { await db.query('delete from director_project_state where project_id=$1', [project.id]); await db.query('delete from director_storyboard_revisions where project_id=$1', [project.id]); await db.query('delete from director_storyboards where project_id=$1', [project.id]); await db.query('delete from director_script_revisions where project_id=$1', [project.id]); await db.query('delete from director_scripts where project_id=$1', [project.id]); await db.query('delete from director_briefs where project_id=$1', [project.id]); await db.query('delete from content_projects where id=$1', [project.id]); await db.end(); }
});

test('production refs reject unknown domain data and approval bypass is explicit', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const project = await new ProjectService(db).create(`Production ${randomUUID()}`);
  try { const service = new ProductionRunService(db); await assert.rejects(() => service.create({ projectId: project.id, title: '非法', approvalRequired: true, approvalBypassed: true }), /PRODUCTION_APPROVAL_BYPASS/); const run = await service.create({ projectId: project.id, title: '合法', approvalRequired: false, approvalBypassed: true }); await assert.rejects(() => service.updateStep(project.id, run.id, { stage: 'CONTENT', status: 'RUNNING', outputRefs: { secretPayload: 'nope' } }), /PRODUCTION_REF_KEY_INVALID/); }
  finally { await db.query('delete from content_projects where id=$1', [project.id]); await db.end(); }
});

test('production handoffs verify accepted script, optional voice fallback, skipped digital human and material snapshot', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const project = await new ProjectService(db).create(`Handoff ${randomUUID()}`); const fixtureRoot = await mkdtemp(join(tmpdir(), 'contentos-production-handoff-')); const fixtureVideo = join(fixtureRoot, 'material.mp4'); await generateFixtureVideo(fixtureVideo, process.env.FFMPEG_PATH || 'ffmpeg', 'blue', 2);
  try {
    const director = new DirectorV1Service(db);
    const brief = await director.createBrief(project.id, { topic: 'handoff', targetPlatform: 'test', channelPositioning: 'test', targetDurationSeconds: 30, contentType: 'short video', audience: 'test', coreThesis: 'test', tone: 'clear', referenceMaterial: 'provided', mustInclude: ['one'], mustAvoid: ['none'], requirements: {}, createdBy: 'test' });
    const aggregate = await director.createScript(project.id, brief.id);
    const script = await director.createScriptRevision(project.id, aggregate.id, { origin: 'MANUAL', title: 'handoff', titleCandidates: ['handoff'], coverText: 'handoff', topicKeywords: ['handoff'], hook: 'hook', body: 'body', createdBy: 'test' });
    const accepted = await director.acceptScript(project.id, script.id);
    const service = new ProductionRunService(db); const run = await service.create({ projectId: project.id, title: 'handoff run' });
    const content = await service.handoff(project.id, run.id, 'CONTENT', { scriptRevisionId: accepted.id }); assert.equal(content.steps.find((step) => step.stage === 'CONTENT')?.status, 'SUCCEEDED');
    const voice = await service.handoff(project.id, run.id, 'VOICE', {}, 'SKIPPED'); assert.equal(voice.steps.find((step) => step.stage === 'VOICE')?.status, 'SKIPPED');
    const digitalHuman = await service.handoff(project.id, run.id, 'DIGITAL_HUMAN', {}); assert.equal(digitalHuman.steps.find((step) => step.stage === 'DIGITAL_HUMAN')?.status, 'SKIPPED');
    const workspaceId = `workspace-project-${project.id}`; await db.query("insert into video_workspaces (id,type,project_id) values ($1,'PROJECT',$2) on conflict (id) do nothing", [workspaceId, project.id]);
    const snapshot = await new ScriptEditingV3Service(db).createMaterialPoolSnapshot({ workspaceId, sourceFiles: [fixtureVideo] });
    const materials = await service.handoff(project.id, run.id, 'MATERIALS', { materialPoolSnapshotId: snapshot.id }); assert.equal(materials.steps.find((step) => step.stage === 'MATERIALS')?.status, 'SUCCEEDED');
    await assert.rejects(() => service.handoff(project.id, run.id, 'EDITING', { editSessionId: 'missing', manifestRevisionId: 'missing' }), /PRODUCTION_EDIT_SESSION_NOT_FOUND/);
  } finally { await db.query('delete from director_project_state where project_id=$1', [project.id]); await db.query('delete from director_storyboard_revisions where project_id=$1', [project.id]); await db.query('delete from director_storyboards where project_id=$1', [project.id]); await db.query('delete from director_script_revisions where project_id=$1', [project.id]); await db.query('delete from director_scripts where project_id=$1', [project.id]); await db.query('delete from director_briefs where project_id=$1', [project.id]); await db.query('delete from content_projects where id=$1', [project.id]); await db.end(); await rm(fixtureRoot, { recursive: true, force: true }); }
});
