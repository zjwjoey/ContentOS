import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { ProductionRunService } from '../../packages/modules/production-run/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test';

async function markRunReady(db: Awaited<ReturnType<typeof createDatabase>>, runId: string, manifestId: string, sessionId = 'session-owned') {
  await db.query("update production_run_steps set status='SUCCEEDED',completed_at=now() where production_run_id=$1 and stage in ('CONTENT','VOICE','DIGITAL_HUMAN','MATERIALS','EDITING','PREVIEW','APPROVAL')", [runId]);
  await db.query("update production_run_steps set output_refs=$2::jsonb where production_run_id=$1 and stage='MATERIALS'", [runId, JSON.stringify({ materialPoolSnapshotId: 'snapshot-owned' })]);
  await db.query("update production_run_steps set output_refs=$2::jsonb where production_run_id=$1 and stage='EDITING'", [runId, JSON.stringify({ editSessionId: sessionId, manifestRevisionId: manifestId })]);
  await db.query("update production_run_steps set output_refs=$2::jsonb where production_run_id=$1 and stage='PREVIEW'", [runId, JSON.stringify({ previewId: 'preview-owned', manifestId })]);
  await db.query("update production_run_steps set output_refs=$2::jsonb where production_run_id=$1 and stage='APPROVAL'", [runId, JSON.stringify({ approvalId: 'approval-owned', manifestRevisionId: manifestId })]);
  await db.query("update production_runs set status='RUNNING',current_stage='RENDER' where id=$1", [runId]);
}

async function insertManifest(db: Awaited<ReturnType<typeof createDatabase>>, projectId: string, workspaceId: string, id: string, revision: number) {
  await db.query("insert into edit_manifests (id,project_id,workspace_id,revision,schema_version,manifest,status,created_by) values ($1,$2,$3,$4,'EDIT_MANIFEST_V0','{}'::jsonb,'PERSISTED','adversarial')", [id, projectId, workspaceId, revision]);
}

async function cleanupProject(db: Awaited<ReturnType<typeof createDatabase>>, projectId: string): Promise<void> {
  await db.query('delete from production_runs where project_id=$1', [projectId]);
  await db.query('delete from publisher_external_posts where request_id in (select id from publisher_requests where project_id=$1)', [projectId]);
  await db.query('delete from publisher_attempts where request_id in (select id from publisher_requests where project_id=$1)', [projectId]);
  await db.query('update publisher_requests set current_revision_id=null where project_id=$1', [projectId]);
  await db.query('delete from publisher_request_revisions where request_id in (select id from publisher_requests where project_id=$1)', [projectId]);
  await db.query('delete from publisher_requests where project_id=$1', [projectId]);
  await db.query('delete from publisher_accounts where project_id=$1', [projectId]);
  await db.query('delete from approval_decisions where project_id=$1', [projectId]);
  await db.query('delete from review_metric_snapshots where project_id=$1', [projectId]);
  await db.query('delete from renders where project_id=$1', [projectId]);
  await db.query('delete from jobs where project_id=$1', [projectId]);
  await db.query('delete from script_editing_v3_sessions where workspace_id in (select id from video_workspaces where project_id=$1)', [projectId]);
  await db.query('delete from edit_manifests where project_id=$1', [projectId]);
  await db.query('delete from material_pool_snapshots where workspace_id in (select id from video_workspaces where project_id=$1)', [projectId]);
  await db.query('delete from project_assets where project_id=$1', [projectId]);
  await db.query('delete from video_workspace_assets where workspace_id in (select id from video_workspaces where project_id=$1)', [projectId]);
  await db.query('delete from assets where project_id=$1', [projectId]);
  await db.query('delete from video_workspaces where project_id=$1', [projectId]);
  await db.query('delete from director_project_state where project_id=$1', [projectId]);
  await db.query('delete from director_storyboard_revisions where project_id=$1', [projectId]);
  await db.query('delete from director_storyboards where project_id=$1', [projectId]);
  await db.query('delete from director_script_revisions where project_id=$1', [projectId]);
  await db.query('delete from director_scripts where project_id=$1', [projectId]);
  await db.query('delete from director_briefs where project_id=$1', [projectId]);
  await db.query('delete from content_projects where id=$1', [projectId]);
}

test('Production Run adversarial integrity matrix A-O rejects forged and cross-lineage handoffs', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const projects: string[] = [];
  try {
    const projectsService = new ProjectService(db); const service = new ProductionRunService(db);
    const projectA = await projectsService.create(`Adversarial A ${randomUUID()}`); const projectB = await projectsService.create(`Adversarial B ${randomUUID()}`); projects.push(projectA.id, projectB.id);
    const workspaceA = `workspace-project-${projectA.id}`; const workspaceB = `workspace-project-${projectB.id}`;
    await db.query("insert into video_workspaces (id,type,project_id) values ($1,'PROJECT',$2),($3,'PROJECT',$4) on conflict (id) do nothing", [workspaceA, projectA.id, workspaceB, projectB.id]);

    const runC = await service.create({ projectId: projectA.id, title: 'Approval lineage' }); const manifestA = `manifest-a-${randomUUID()}`; const manifestB = `manifest-b-${randomUUID()}`;
    await insertManifest(db, projectA.id, workspaceA, manifestA, 1); await insertManifest(db, projectA.id, workspaceA, manifestB, 2); await markRunReady(db, runC.id, manifestB);
    await db.query("insert into approval_decisions (id,project_id,target_type,target_id,target_revision_id,revision,schema_version,status,approver) values ($1,$2,'RENDER',$3,$3,1,'APPROVAL_V0','APPROVED','test')", [`approval-a-${randomUUID()}`, projectA.id, manifestA]);
    const approvalA = (await db.query<{ id: string }>("select id from approval_decisions where project_id=$1 and target_id=$2", [projectA.id, manifestA])).rows[0]!.id;
    await assert.rejects(() => service.handoff(projectA.id, runC.id, 'APPROVAL', { approvalId: approvalA, manifestRevisionId: manifestB }), /PRODUCTION_APPROVAL_MANIFEST_MISMATCH/); // C

    const runD = await service.create({ projectId: projectB.id, title: 'Cross project approval' }); await markRunReady(db, runD.id, manifestB);
    await assert.rejects(() => service.handoff(projectB.id, runD.id, 'APPROVAL', { approvalId: approvalA, manifestRevisionId: manifestB }), /PRODUCTION_APPROVAL_MANIFEST_MISMATCH/); // D

    const snapshotA = `snapshot-a-${randomUUID()}`; const sessionA = `session-a-${randomUUID()}`;
    await db.query("insert into material_pool_snapshots (id,workspace_id,revision) values ($1,$2,1)", [snapshotA, workspaceA]);
    await db.query("insert into script_editing_v3_sessions (id,workspace_id,material_pool_snapshot_id,script,status) values ($1,$2,$3,'test','READY')", [sessionA, workspaceA, snapshotA]);
    await db.query("update production_run_steps set status='SUCCEEDED',output_refs=$2::jsonb where production_run_id=$1 and stage in ('CONTENT','VOICE','DIGITAL_HUMAN','MATERIALS')", [runC.id, JSON.stringify({ materialPoolSnapshotId: snapshotA })]);
    await db.query("update production_runs set status='RUNNING' where id=$1", [runC.id]);
    await assert.rejects(() => service.handoff(projectA.id, runC.id, 'EDITING', { editSessionId: sessionA, manifestRevisionId: manifestB }), /PRODUCTION_MANIFEST_SESSION_MISMATCH/); // E

    const assetA = `asset-a-${randomUUID()}`; const assetB = `asset-b-${randomUUID()}`; const assetC = `asset-c-${randomUUID()}`;
    for (const [id, checksum] of [[assetA, 'checksum-a'], [assetB, 'checksum-b'], [assetC, 'checksum-c']]) await db.query("insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle) values ($1,$2,'VIDEO_RENDER',$3,1,$4,'READY')", [id, projectA.id, `${checksum}-${randomUUID()}`, `renders/${id}.mp4`]);
    const renderA = `render-a-${randomUUID()}`; await db.query("insert into renders (id,project_id,workspace_id,manifest_id,status,output_asset_id) values ($1,$2,$3,$4,'SUCCEEDED',$5)", [renderA, projectA.id, workspaceA, manifestA, assetA]);
    await assert.rejects(() => service.handoff(projectA.id, runC.id, 'RENDER', { renderId: renderA, renderAssetId: assetA, manifestRevisionId: manifestB }), /PRODUCTION_RENDER_MANIFEST_MISMATCH/); // G
    await assert.rejects(() => service.handoff(projectA.id, runC.id, 'RENDER', { renderAssetId: assetC, manifestRevisionId: manifestB }), /PRODUCTION_RENDER_ASSET_MANIFEST_MISMATCH/); // H

    const runI = await service.create({ projectId: projectA.id, title: 'Overwrite' }); await service.updateStep(projectA.id, runI.id, { stage: 'CONTENT', status: 'SUCCEEDED', outputRefs: { contentId: 'script-a' } }, { allowTerminalTransition: true });
    await assert.rejects(() => service.updateStep(projectA.id, runI.id, { stage: 'CONTENT', status: 'SUCCEEDED', outputRefs: { contentId: 'script-b' } }, { allowTerminalTransition: true }), /PRODUCTION_STEP_ALREADY_SUCCEEDED/); // I
    const same = await service.updateStep(projectA.id, runI.id, { stage: 'CONTENT', status: 'SUCCEEDED', outputRefs: { contentId: 'script-a' } }, { allowTerminalTransition: true }); assert.equal(same.trace.contentId, 'script-a'); // J

    const runK = await service.create({ projectId: projectA.id, title: 'Cancelled' }); await service.cancel(projectA.id, runK.id);
    await assert.rejects(() => service.handoff(projectA.id, runK.id, 'CONTENT', { scriptRevisionId: 'nope' }), /PRODUCTION_RUN_TERMINAL/); await assert.rejects(() => service.updateStep(projectA.id, runK.id, { stage: 'CONTENT', status: 'RUNNING' }), /PRODUCTION_RUN_TERMINAL/); await assert.rejects(() => service.retry(projectA.id, runK.id, 'CONTENT'), /PRODUCTION_RUN_TERMINAL/); // K
    const jobK = `job-k-${randomUUID()}`; await db.query("insert into jobs (id,project_id,type,state,idempotency_key,payload) values ($1,$2,'VIDEO_RENDER','SUCCEEDED',$3,'{}'::jsonb)", [jobK, projectA.id, `key-${jobK}`]); await db.query("update production_run_steps set output_refs=$2::jsonb where production_run_id=$1 and stage='CONTENT'", [runK.id, JSON.stringify({ jobId: jobK })]); const stillCancelled = await service.reconcile(projectA.id, runK.id); assert.equal(stillCancelled.status, 'CANCELLED'); // L
    const runM = await service.create({ projectId: projectA.id, title: 'Completed' }); await db.query("update production_runs set status='COMPLETED' where id=$1", [runM.id]); await assert.rejects(() => service.handoff(projectA.id, runM.id, 'CONTENT', { scriptRevisionId: 'nope' }), /PRODUCTION_RUN_TERMINAL/); await assert.rejects(() => service.updateStep(projectA.id, runM.id, { stage: 'CONTENT', status: 'RUNNING' }), /PRODUCTION_RUN_TERMINAL/); // M

    const runN = await service.create({ projectId: projectA.id, title: 'Preview lineage' }); await markRunReady(db, runN.id, manifestB, sessionA); const previewA = `preview-a-${randomUUID()}`;
    await db.query("insert into jobs (id,project_id,workspace_id,type,state,idempotency_key,payload) values ($1,$2,$3,'EDIT_V3_DRAFT_PREVIEW','SUCCEEDED',$4,$5::jsonb)", [previewA, projectA.id, workspaceA, `key-${previewA}`, JSON.stringify({ manifestId: manifestA, sessionId: sessionA, workspaceId: workspaceA })]);
    await assert.rejects(() => service.handoff(projectA.id, runN.id, 'PREVIEW', { previewId: previewA }), /PRODUCTION_PREVIEW_MANIFEST_MISMATCH/); // N

    const account = `account-${randomUUID()}`; const requestId = `request-${randomUUID()}`; const revisionId = `revision-${randomUUID()}`;
    await db.query("insert into publisher_accounts (id,project_id,platform_id,display_name,credential_ref,profile_key,status) values ($1,$2,'fake', $3,'credential','profile','READY')", [account, projectA.id, account]);
    await db.query("insert into publisher_requests (id,project_id,account_id,status,idempotency_key,correlation_id) values ($1,$2,$3,'DRAFT',$4,'test')", [requestId, projectA.id, account, `key-${requestId}`]);
    await db.query("insert into publisher_request_revisions (id,request_id,revision,asset_id,asset_checksum,title,created_by) values ($1,$2,1,$3,'checksum-a','wrong','test')", [revisionId, requestId, assetA]);
    await db.query('update publisher_requests set current_revision_id=$2 where id=$1', [requestId, revisionId]);
    const runO = await service.create({ projectId: projectA.id, title: 'Publish lineage' }); await markRunReady(db, runO.id, manifestB); await db.query("update production_run_steps set status='SUCCEEDED',output_refs=$2::jsonb where production_run_id=$1 and stage='RENDER'", [runO.id, JSON.stringify({ renderAssetId: assetB, renderId: renderA })]); await db.query("update production_runs set status='RUNNING' where id=$1", [runO.id]);
    await assert.rejects(() => service.handoff(projectA.id, runO.id, 'PUBLISH', { publishRequestId: requestId }), /PRODUCTION_PUBLISH_REQUEST_MISMATCH/); // O
  } finally { for (const projectId of projects) await cleanupProject(db, projectId); await db.end(); }
});
