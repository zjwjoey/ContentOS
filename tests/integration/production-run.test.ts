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

async function cleanupProductionProject(db: Awaited<ReturnType<typeof createDatabase>>, projectId: string): Promise<void> {
  await db.query('delete from publisher_external_posts where request_id in (select id from publisher_requests where project_id=$1)', [projectId]);
  await db.query('delete from publisher_attempts where request_id in (select id from publisher_requests where project_id=$1)', [projectId]);
  await db.query('update publisher_requests set current_revision_id=null where project_id=$1', [projectId]);
  await db.query('delete from publisher_request_revisions where request_id in (select id from publisher_requests where project_id=$1)', [projectId]);
  await db.query('delete from publisher_requests where project_id=$1', [projectId]);
  await db.query('delete from approval_decisions where project_id=$1', [projectId]);
  await db.query('delete from review_metric_snapshots where project_id=$1', [projectId]);
  await db.query('delete from renders where project_id=$1', [projectId]);
  await db.query('delete from production_runs where project_id=$1', [projectId]);
  await db.query('delete from jobs where project_id=$1', [projectId]);
  await db.query('delete from script_editing_v3_sessions where workspace_id in (select id from video_workspaces where project_id=$1)', [projectId]);
  await db.query('delete from edit_manifests where project_id=$1', [projectId]);
  await db.query('delete from material_pool_snapshots where workspace_id in (select id from video_workspaces where project_id=$1)', [projectId]);
  await db.query('delete from project_assets where project_id=$1', [projectId]);
  await db.query('delete from video_workspace_assets where workspace_id in (select id from video_workspaces where project_id=$1)', [projectId]);
  await db.query('delete from assets where project_id=$1', [projectId]);
  await db.query('delete from video_workspaces where project_id=$1', [projectId]);
  await db.query('delete from content_projects where id=$1', [projectId]);
}

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
    await service.updateStep(project.id, first.id, { stage: 'CONTENT', status: 'SUCCEEDED', outputRefs: { contentId: 'content-1' } }, { allowTerminalTransition: true });
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

test('W: approval-disabled runs initialize APPROVAL as SKIPPED and allow Render', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const project = await new ProjectService(db).create(`Optional approval ${randomUUID()}`); const service = new ProductionRunService(db);
  try {
    const run = await service.create({ projectId: project.id, title: 'No approval', approvalRequired: false });
    assert.equal(run.steps.find((step) => step.stage === 'APPROVAL')?.status, 'SKIPPED');
    const workspaceId = `workspace-project-${project.id}`; const snapshotId = `snapshot-${run.id}`; const sessionId = `session-${run.id}`; const manifestId = `manifest-${run.id}`; const assetId = `asset-${run.id}`; const renderId = `render-${run.id}`;
    await db.query("insert into video_workspaces (id,type,project_id) values ($1,'PROJECT',$2) on conflict (id) do nothing", [workspaceId, project.id]);
    await db.query('insert into material_pool_snapshots (id,workspace_id,revision) values ($1,$2,1)', [snapshotId, workspaceId]);
    await db.query("insert into edit_manifests (id,project_id,workspace_id,revision,schema_version,manifest,status,created_by) values ($1,$2,$3,1,'EDIT_MANIFEST_V0','{}'::jsonb,'PERSISTED','test')", [manifestId, project.id, workspaceId]);
    await db.query("insert into script_editing_v3_sessions (id,workspace_id,material_pool_snapshot_id,script,status,current_manifest_id) values ($1,$2,$3,'optional','READY',$4)", [sessionId, workspaceId, snapshotId, manifestId]);
    await db.query("insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle) values ($1,$2,'VIDEO_RENDER',$3,1,$4,'READY')", [assetId, project.id, `checksum-${run.id}`, `renders/${assetId}.mp4`]);
    await db.query("insert into renders (id,project_id,workspace_id,manifest_id,status,output_asset_id) values ($1,$2,$3,$4,'SUCCEEDED',$5)", [renderId, project.id, workspaceId, manifestId, assetId]);
    await db.query("update production_run_steps set status='SUCCEEDED',output_refs=$2::jsonb where production_run_id=$1 and stage in ('CONTENT','MATERIALS','EDITING','PREVIEW')", [run.id, JSON.stringify({ materialPoolSnapshotId: snapshotId, editSessionId: sessionId, manifestRevisionId: manifestId, previewId: `preview-${run.id}` })]);
    await db.query("update production_run_steps set status='SKIPPED' where production_run_id=$1 and stage='VOICE'", [run.id]);
    await db.query("update production_runs set status='RUNNING' where id=$1", [run.id]);
    const approvalCount = await db.query('select count(*)::int as count from approval_decisions where project_id=$1', [project.id]);
    const rendered = await service.handoff(project.id, run.id, 'RENDER', { renderId, renderAssetId: assetId, manifestRevisionId: manifestId });
    assert.equal(rendered.steps.find((step) => step.stage === 'RENDER')?.status, 'SUCCEEDED');
    assert.equal(rendered.steps.find((step) => step.stage === 'APPROVAL')?.status, 'SKIPPED');
    const approvalAfter = await db.query('select count(*)::int as count from approval_decisions where project_id=$1', [project.id]); assert.equal(approvalAfter.rows[0].count, approvalCount.rows[0].count);
  } finally { await cleanupProductionProject(db, project.id); await db.end(); }
});

test('X: skipping Publish automatically skips Review and completes without publisher or review side effects', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const project = await new ProjectService(db).create(`Optional publish ${randomUUID()}`); const service = new ProductionRunService(db);
  try {
    const run = await service.create({ projectId: project.id, title: 'No publish' });
    await db.query("update production_run_steps set status='SUCCEEDED' where production_run_id=$1 and stage in ('CONTENT','VOICE','DIGITAL_HUMAN','MATERIALS','EDITING','PREVIEW','APPROVAL','RENDER')", [run.id]);
    await db.query("update production_runs set status='RUNNING',current_stage='PUBLISH' where id=$1", [run.id]);
    const before = await db.query<{ requests: number; jobs: number; posts: number; reviews: number }>("select (select count(*)::int from publisher_requests where project_id=$1) requests,(select count(*)::int from jobs where project_id=$1 and type='PUBLISH') jobs,(select count(*)::int from publisher_external_posts where request_id in (select id from publisher_requests where project_id=$1)) posts,(select count(*)::int from review_metric_snapshots where project_id=$1) reviews", [project.id]);
    const skipped = await service.handoff(project.id, run.id, 'PUBLISH', {}, 'SKIPPED');
    assert.equal(skipped.steps.find((step) => step.stage === 'PUBLISH')?.status, 'SKIPPED'); assert.equal(skipped.steps.find((step) => step.stage === 'REVIEW')?.status, 'SKIPPED'); assert.equal(skipped.status, 'COMPLETED_WITHOUT_PUBLISH'); assert.ok(skipped.completedAt);
    const after = await db.query<{ requests: number; jobs: number; posts: number; reviews: number }>("select (select count(*)::int from publisher_requests where project_id=$1) requests,(select count(*)::int from jobs where project_id=$1 and type='PUBLISH') jobs,(select count(*)::int from publisher_external_posts where request_id in (select id from publisher_requests where project_id=$1)) posts,(select count(*)::int from review_metric_snapshots where project_id=$1) reviews", [project.id]); assert.deepEqual(after.rows[0], before.rows[0]);
    await assert.rejects(() => service.updateStep(project.id, run.id, { stage: 'PUBLISH', status: 'RUNNING' }), /PRODUCTION_RUN_TERMINAL/); await assert.rejects(() => service.retry(project.id, run.id, 'PUBLISH'), /PRODUCTION_RUN_TERMINAL/); await assert.rejects(() => service.handoff(project.id, run.id, 'PUBLISH', {}, 'SKIPPED'), /PRODUCTION_RUN_TERMINAL/);
  } finally { await cleanupProductionProject(db, project.id); await db.end(); }
});

test('Y: approval-disabled plus Publish skipped closes the no-external-dependency flow', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const project = await new ProjectService(db).create(`Optional combined ${randomUUID()}`); const service = new ProductionRunService(db);
  try {
    const run = await service.create({ projectId: project.id, title: 'Combined optional stages', approvalRequired: false }); assert.equal(run.steps.find((step) => step.stage === 'APPROVAL')?.status, 'SKIPPED');
    await db.query("update production_run_steps set status='SUCCEEDED' where production_run_id=$1 and stage in ('CONTENT','MATERIALS','EDITING','PREVIEW','RENDER')", [run.id]); await db.query("update production_run_steps set status='SKIPPED' where production_run_id=$1 and stage in ('VOICE','DIGITAL_HUMAN')", [run.id]); await db.query("update production_runs set status='RUNNING',current_stage='PUBLISH' where id=$1", [run.id]);
    const completed = await service.handoff(project.id, run.id, 'PUBLISH', {}, 'SKIPPED');
    assert.equal(completed.steps.find((step) => step.stage === 'APPROVAL')?.status, 'SKIPPED'); assert.equal(completed.steps.find((step) => step.stage === 'PUBLISH')?.status, 'SKIPPED'); assert.equal(completed.steps.find((step) => step.stage === 'REVIEW')?.status, 'SKIPPED'); assert.equal(completed.status, 'COMPLETED_WITHOUT_PUBLISH');
  } finally { await cleanupProductionProject(db, project.id); await db.end(); }
});
