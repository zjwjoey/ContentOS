import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test';

test('Production Run API exposes durable creation, detail and guarded handoff endpoints', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const app = await buildApi(db);
  let projectId = '';
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: `Production API ${Date.now()}` } }); assert.equal(project.statusCode, 201); projectId = project.json().id as string;
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs`, payload: { title: 'API 闭环', idempotencyKey: 'api-same-click' } }); assert.equal(created.statusCode, 201); const run = created.json();
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs`, payload: { title: '不同标题', idempotencyKey: 'api-same-click' } }); assert.equal(duplicate.statusCode, 201); assert.equal(duplicate.json().id, run.id);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/production-runs/${run.id}` }); assert.equal(detail.statusCode, 200); assert.equal(detail.json().steps.length, 10);
    const guarded = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs/${run.id}/handoff/DIGITAL_HUMAN`, payload: { outputRefs: {}, status: 'SKIPPED' } }); assert.equal(guarded.statusCode, 409); assert.match(guarded.json().error.code, /PREVIOUS_STAGE_NOT_READY/);
  } finally { if (projectId) await db.query('delete from content_projects where id=$1', [projectId]); await app.close?.().catch(() => undefined); await db.end(); }
});

test('Production Run public step API rejects terminal success claims and validates generate ownership before side effects', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const app = await buildApi(db); let projectId = '';
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: `Production adversarial ${Date.now()}` } }); projectId = project.json().id as string;
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs`, payload: { title: 'Adversarial' } }); const run = created.json();
    const forgedEditing = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs/${run.id}/steps/EDITING`, payload: { status: 'RUNNING', outputRefs: { manifestRevisionId: 'forged-manifest' } } });
    assert.equal(forgedEditing.statusCode, 422); assert.equal(forgedEditing.json().error.code, 'VALIDATION_ERROR');
    const forgedRender = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs/${run.id}/steps/RENDER`, payload: { status: 'RUNNING', renderAssetId: 'forged-asset', approvalId: 'forged-approval', publishRequestId: 'forged-request' } });
    assert.equal(forgedRender.statusCode, 422); assert.equal(forgedRender.json().error.code, 'VALIDATION_ERROR');
    const cleanTrace = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/production-runs/${run.id}` });
    assert.equal(cleanTrace.statusCode, 200); assert.equal(cleanTrace.json().trace.manifestRevisionId, undefined); assert.equal(cleanTrace.json().trace.renderAssetId, undefined);
    for (const stage of ['APPROVAL', 'RENDER']) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs/${run.id}/steps/${stage}`, payload: { status: 'SUCCEEDED', outputRefs: {} } });
      assert.equal(response.statusCode, 422); assert.equal(response.json().error.code, 'VALIDATION_ERROR');
    }
    const workspaceId = `workspace-project-${projectId}`;
    await db.query("insert into video_workspaces (id,type,project_id) values ($1,'PROJECT',$2) on conflict (id) do nothing", [workspaceId, projectId]);
    const before = await db.query('select count(*)::int as count from edit_manifests where workspace_id=$1', [workspaceId]);
    await db.query("update production_run_steps set status='RUNNING',output_refs=$2::jsonb where production_run_id=$1 and stage='EDITING'", [run.id, JSON.stringify({ editSessionId: 'session-owned-by-run' })]);
    const wrongSession = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs/${run.id}/editing-session/wrong-session/generate`, payload: {} });
    assert.equal(wrongSession.statusCode, 409); assert.equal(wrongSession.json().error.code, 'PRODUCTION_EDIT_SESSION_MISMATCH');
    const after = await db.query('select count(*)::int as count from edit_manifests where workspace_id=$1', [workspaceId]); assert.equal(after.rows[0].count, before.rows[0].count);
  } finally {
    if (projectId) {
      await db.query('delete from production_runs where project_id=$1', [projectId]);
      await db.query('delete from jobs where project_id=$1', [projectId]);
      await db.query('delete from approval_decisions where project_id=$1', [projectId]);
      await db.query('delete from script_editing_v3_sessions where workspace_id in (select id from video_workspaces where project_id=$1)', [projectId]);
      await db.query('delete from edit_manifests where project_id=$1', [projectId]);
      await db.query('delete from material_pool_snapshots where workspace_id in (select id from video_workspaces where project_id=$1)', [projectId]);
      await db.query('delete from video_workspaces where project_id=$1', [projectId]);
      await db.query('delete from content_projects where id=$1', [projectId]);
    }
    await app.close?.().catch(() => undefined); await db.end();
  }
});

test('Production Run terminal routes reject before any domain side effect (P-V)', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const app = await buildApi(db); let projectId = '';
  const mutations = (runId: string): Array<{ method: 'POST'; url: string; payload: Record<string, unknown> }> => [
    ['voice', { voiceProfileId: 'voice-profile', text: 'terminal' }],
    ['digital-human', { avatarProfileId: 'avatar-profile', avatarClipId: 'avatar-clip', speechAssetId: 'speech-asset' }],
    ['editing-session', { scriptRevisionId: 'script', materialPoolSnapshotId: 'snapshot' }],
    [`editing-session/wrong-session/generate`, {}],
    ['preview', {}],
    ['request-approval', {}],
    ['approve', {}],
    ['request-changes', { reason: 'terminal' }],
    ['render', {}],
    ['publisher-request', { accountId: 'account', title: 'terminal', description: '', hashtags: [] }],
    ['publish', {}],
  ].map(([suffix, payload]) => ({ method: 'POST' as const, url: `/api/v1/projects/${projectId}/production-runs/${runId}/${suffix}`, payload: payload as Record<string, unknown> }));
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: `Production terminal ${Date.now()}` } }); projectId = project.json().id as string;
    const cancelled = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs`, payload: { title: 'Cancelled terminal' } }); const cancelledRun = cancelled.json();
    await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs/${cancelledRun.id}/cancel` });
    const completed = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs`, payload: { title: 'Completed terminal' } }); const completedRun = completed.json();
    await db.query("update production_runs set status='COMPLETED',completed_at=now() where id=$1", [completedRun.id]);
    for (const runId of [cancelledRun.id, completedRun.id]) {
      const before = await db.query<{ jobs: number; renders: number; approvals: number; requests: number; manifests: number }>("select (select count(*)::int from jobs where project_id=$1) jobs,(select count(*)::int from renders where project_id=$1) renders,(select count(*)::int from approval_decisions where project_id=$1) approvals,(select count(*)::int from publisher_requests where project_id=$1) requests,(select count(*)::int from edit_manifests where project_id=$1) manifests", [projectId]);
      for (const mutation of mutations(runId)) { const response = await app.inject(mutation); assert.equal(response.statusCode, 409, `${mutation.url} should be terminal-guarded`); assert.equal(response.json().error.code, 'PRODUCTION_RUN_TERMINAL'); }
      const after = await db.query<{ jobs: number; renders: number; approvals: number; requests: number; manifests: number }>("select (select count(*)::int from jobs where project_id=$1) jobs,(select count(*)::int from renders where project_id=$1) renders,(select count(*)::int from approval_decisions where project_id=$1) approvals,(select count(*)::int from publisher_requests where project_id=$1) requests,(select count(*)::int from edit_manifests where project_id=$1) manifests", [projectId]);
      assert.deepEqual(after.rows[0], before.rows[0]);
    }
  } finally { if (projectId) await db.query('delete from content_projects where id=$1', [projectId]); await app.close?.().catch(() => undefined); await db.end(); }
});

test('Production Run request-approval requires a current successful non-stale preview', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const app = await buildApi(db); let projectId = '';
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: `Preview approval ${Date.now()}` } }); projectId = project.json().id as string;
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs`, payload: { title: 'Preview gate' } }); const run = created.json();
    const manifestId = `manifest-preview-${run.id}`; const sessionId = `session-preview-${run.id}`; const workspaceId = `workspace-project-${projectId}`; const previewJobId = `job-preview-${run.id}`;
    await db.query("insert into video_workspaces (id,type,project_id) values ($1,'PROJECT',$2) on conflict (id) do nothing", [workspaceId, projectId]);
    await db.query("insert into edit_manifests (id,project_id,workspace_id,revision,schema_version,manifest,status,created_by) values ($1,$2,$3,1,'EDIT_MANIFEST_V0','{}'::jsonb,'PERSISTED','test')", [manifestId, projectId, workspaceId]);
    await db.query("insert into material_pool_snapshots (id,workspace_id,revision) values ($1,$2,1)", [`snapshot-${run.id}`, workspaceId]);
    await db.query("insert into script_editing_v3_sessions (id,workspace_id,material_pool_snapshot_id,script,status,current_manifest_id) values ($1,$2,$3,'preview','READY',$4)", [sessionId, workspaceId, `snapshot-${run.id}`, manifestId]);
    await db.query("update production_run_steps set status='SUCCEEDED',output_refs=$2::jsonb where production_run_id=$1 and stage='EDITING'", [run.id, JSON.stringify({ editSessionId: sessionId, manifestRevisionId: manifestId, materialPoolSnapshotId: `snapshot-${run.id}` })]);
    await db.query("update production_run_steps set status='PENDING',output_refs=$2::jsonb where production_run_id=$1 and stage='PREVIEW'", [run.id, JSON.stringify({ jobId: previewJobId, manifestId })]);
    await db.query("update production_runs set status='RUNNING' where id=$1", [run.id]);
    const requestApproval = () => app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/production-runs/${run.id}/request-approval`, payload: { approver: 'test' } });
    let response = await requestApproval(); assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'PRODUCTION_PREVIEW_REQUIRED');
    await db.query("update production_run_steps set status='FAILED',error_code='PREVIEW_FAILED' where production_run_id=$1 and stage='PREVIEW'", [run.id]);
    response = await requestApproval(); assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'PRODUCTION_PREVIEW_REQUIRED');
    await db.query("update production_run_steps set status='SUCCEEDED',stale_at=now() where production_run_id=$1 and stage='PREVIEW'", [run.id]);
    response = await requestApproval(); assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'PRODUCTION_PREVIEW_REQUIRED');
    await db.query("update production_run_steps set stale_at=null where production_run_id=$1 and stage='PREVIEW'", [run.id]);
    await db.query("insert into jobs (id,project_id,workspace_id,type,state,idempotency_key,payload) values ($1,$2,$3,'EDIT_V3_DRAFT_PREVIEW','SUCCEEDED',$4,$5::jsonb)", [previewJobId, projectId, workspaceId, `key-${previewJobId}`, JSON.stringify({ manifestId: 'old-manifest', sessionId, workspaceId })]);
    response = await requestApproval(); assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'PRODUCTION_PREVIEW_MANIFEST_MISMATCH');
    await db.query("update jobs set payload=jsonb_set(payload,'{manifestId}',to_jsonb($2::text)) where id=$1", [previewJobId, manifestId]);
    response = await requestApproval(); assert.equal(response.statusCode, 201); assert.equal(response.json().approval.targetId, manifestId);
  } finally {
    if (projectId) {
      await db.query('delete from production_runs where project_id=$1', [projectId]);
      await db.query('delete from jobs where project_id=$1', [projectId]);
      await db.query('delete from approval_decisions where project_id=$1', [projectId]);
      await db.query('delete from script_editing_v3_sessions where workspace_id in (select id from video_workspaces where project_id=$1)', [projectId]);
      await db.query('delete from edit_manifests where project_id=$1', [projectId]);
      await db.query('delete from material_pool_snapshots where workspace_id in (select id from video_workspaces where project_id=$1)', [projectId]);
      await db.query('delete from video_workspaces where project_id=$1', [projectId]);
      await db.query('delete from content_projects where id=$1', [projectId]);
    }
    await app.close?.().catch(() => undefined); await db.end();
  }
});

test('Production Run render rechecks project, workspace, session and manifest lineage before creating a job', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const app = await buildApi(db); let projectA = ''; let projectB = '';
  const cleanup = async (projectId: string) => {
    await db.query('delete from production_runs where project_id=$1', [projectId]);
    await db.query('delete from jobs where project_id=$1', [projectId]);
    await db.query('delete from script_editing_v3_sessions where workspace_id in (select id from video_workspaces where project_id=$1)', [projectId]);
    await db.query('delete from edit_manifests where project_id=$1', [projectId]);
    await db.query('delete from material_pool_snapshots where workspace_id in (select id from video_workspaces where project_id=$1)', [projectId]);
    await db.query('delete from video_workspaces where project_id=$1', [projectId]);
    await db.query('delete from content_projects where id=$1', [projectId]);
  };
  try {
    projectA = (await (await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: `Render lineage A ${Date.now()}` } })).json()).id;
    projectB = (await (await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: `Render lineage B ${Date.now()}` } })).json()).id;
    const run = (await (await app.inject({ method: 'POST', url: `/api/v1/projects/${projectA}/production-runs`, payload: { title: 'Render lineage', approvalRequired: false } })).json());
    const workspaceA = `workspace-project-${projectA}`; const workspaceB = `workspace-project-${projectB}`; const snapshot = `snapshot-render-${run.id}`; const session = `session-render-${run.id}`; const manifestA = `manifest-render-a-${run.id}`; const manifestB = `manifest-render-b-${run.id}`; const manifestForeign = `manifest-render-foreign-${run.id}`;
    await db.query("insert into video_workspaces (id,type,project_id) values ($1,'PROJECT',$2),($3,'PROJECT',$4) on conflict (id) do nothing", [workspaceA, projectA, workspaceB, projectB]);
    await db.query("insert into edit_manifests (id,project_id,workspace_id,revision,schema_version,manifest,status,created_by) values ($1,$2,$3,1,'EDIT_MANIFEST_V0','{}'::jsonb,'PERSISTED','test'),($4,$2,$3,2,'EDIT_MANIFEST_V0','{}'::jsonb,'PERSISTED','test'),($5,$6,$7,1,'EDIT_MANIFEST_V0','{}'::jsonb,'PERSISTED','test')", [manifestA, projectA, workspaceA, manifestB, manifestForeign, projectB, workspaceB]);
    await db.query("insert into material_pool_snapshots (id,workspace_id,revision) values ($1,$2,1)", [snapshot, workspaceA]);
    await db.query("insert into script_editing_v3_sessions (id,workspace_id,material_pool_snapshot_id,script,status,current_manifest_id) values ($1,$2,$3,'render','READY',$4)", [session, workspaceA, snapshot, manifestA]);
    await db.query("update production_run_steps set status='SUCCEEDED',output_refs=$2::jsonb where production_run_id=$1 and stage='EDITING'", [run.id, JSON.stringify({ editSessionId: session, manifestRevisionId: manifestB, materialPoolSnapshotId: snapshot })]);
    await db.query("update production_runs set status='RUNNING' where id=$1", [run.id]);
    const before = await db.query('select count(*)::int as count from jobs where project_id=$1', [projectA]);
    let response = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectA}/production-runs/${run.id}/render`, payload: {} });
    assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'PRODUCTION_MANIFEST_SESSION_MISMATCH');
    await db.query("update production_run_steps set output_refs=jsonb_set(output_refs,'{manifestRevisionId}',to_jsonb($2::text)) where production_run_id=$1 and stage='EDITING'", [run.id, manifestForeign]);
    response = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectA}/production-runs/${run.id}/render`, payload: {} });
    assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'PRODUCTION_RENDER_MANIFEST_MISMATCH');
    const after = await db.query('select count(*)::int as count from jobs where project_id=$1', [projectA]); assert.equal(after.rows[0].count, before.rows[0].count);
  } finally { if (projectA) await cleanup(projectA); if (projectB) await cleanup(projectB); await app.close?.().catch(() => undefined); await db.end(); }
});
