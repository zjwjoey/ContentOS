import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { DirectorV1Service } from '../../packages/modules/director/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:5432/contentos_test';

test('Video workspace API exposes safe reads, explicit source selection, and project-scoped cancel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-video-api-'));
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const projects = new ProjectService(db);
  const project = await projects.create('Video workspace ' + randomUUID());
  const foreign = await projects.create('Video workspace foreign ' + randomUUID());
  const sourceAssetId = `asset-video-api-${randomUUID()}`;
  const app = await buildApi({ db, storage: new LocalStorageProvider(join(root, 'storage')) });
  const director = new DirectorV1Service(db);
  let jobId: string | undefined;
  try {
    const empty = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/video` });
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json().schemaVersion, 'VIDEO_WORKSPACE_V0');
    assert.equal(empty.json().director.ready, false);
    assert.equal('storageKey' in empty.json(), false);

    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [
      sourceAssetId,
      project.id,
      'VIDEO',
      `sha256:${sourceAssetId}`,
      100,
      `source/${sourceAssetId}.mp4`,
      'READY',
      { durationMs: 1000, width: 1080, height: 1920, format: 'mp4' },
    ]);
    await db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3)', [project.id, sourceAssetId, 'SOURCE']);
    const brief = await director.createBrief(project.id, {
      topic: '主题',
      targetPlatform: 'douyin',
      channelPositioning: '栏目',
      targetDurationSeconds: 30,
      contentType: 'knowledge',
      audience: '运营',
      coreThesis: '观点',
      tone: '清晰',
      referenceMaterial: '材料',
      mustInclude: ['事实'],
      mustAvoid: ['夸大'],
      requirements: {},
      createdBy: 'operator',
    });
    const scriptAggregate = await director.createScript(project.id, brief.id);
    const script = await director.createScriptRevision(project.id, scriptAggregate.id, {
      origin: 'MANUAL',
      title: '脚本',
      titleCandidates: ['脚本'],
      coverText: '封面',
      topicKeywords: ['主题'],
      hook: '开头',
      body: '正文',
      createdBy: 'operator',
    });
    const accepted = await director.acceptScript(project.id, script.id);
    const storyboardAggregate = await director.createStoryboard(project.id);
    const storyboard = await director.createStoryboardRevision(project.id, storyboardAggregate.id, {
      origin: 'MANUAL',
      scriptRevisionId: accepted.id,
      scenes: [{ sceneIndex: 1, voiceoverText: '旁白', durationHintSeconds: 1, visualInstruction: '画面', assetKeywords: ['主题'] }],
      createdBy: 'operator',
    });
    await director.approveStoryboard(project.id, storyboard.id);

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/video/jobs`,
      payload: {
        videoAssetIds: [sourceAssetId],
        plannerMode: 'STORYBOARD_V1',
        sceneAssetBindings: [{ sceneIndex: 1, assetIds: [sourceAssetId] }],
        targetDurationMs: 1000,
        seed: 7,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    jobId = created.json().id;
    assert.equal(created.json().type, 'VIDEO_RENDER');
    const snapshot = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/video` });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.json().director.ready, true);
    assert.deepEqual(snapshot.json().sourceAssets[0], {
      id: sourceAssetId,
      kind: 'VIDEO',
      lifecycle: 'READY',
      byteSize: 100,
      checksum: `sha256:${sourceAssetId}`,
      originalName: `${sourceAssetId}.mp4`,
      metadata: { durationMs: 1000, width: 1080, height: 1920, format: 'mp4' },
    });
    assert.equal(snapshot.json().job.id, jobId);
    assert.doesNotMatch(snapshot.body, /storageKey|sourcePath|leaseOwner|diagnostics|payload/);

    const foreignCancel = await app.inject({ method: 'POST', url: `/api/v1/projects/${foreign.id}/video/jobs/${jobId}/cancel`, payload: {} });
    assert.equal(foreignCancel.statusCode, 404);
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/video/jobs/${jobId}/cancel`, payload: {} });
    assert.equal(cancel.statusCode, 200);
    assert.equal(cancel.json().state, 'CANCELLED');
  } finally {
    await app.close();
    if (jobId) {
      await db.query('delete from job_events where job_id = $1', [jobId]);
      await db.query('delete from job_attempts where job_id = $1', [jobId]);
      await db.query('delete from jobs where id = $1', [jobId]);
    }
    await db.query('delete from director_project_state where project_id in ($1, $2)', [project.id, foreign.id]);
    await db.query('delete from director_storyboard_revisions where project_id in ($1, $2)', [project.id, foreign.id]);
    await db.query('delete from director_storyboards where project_id in ($1, $2)', [project.id, foreign.id]);
    await db.query('delete from director_script_revisions where project_id in ($1, $2)', [project.id, foreign.id]);
    await db.query('delete from director_scripts where project_id in ($1, $2)', [project.id, foreign.id]);
    await db.query('delete from director_briefs where project_id in ($1, $2)', [project.id, foreign.id]);
    await db.query('delete from project_assets where project_id in ($1, $2)', [project.id, foreign.id]);
    await db.query('delete from assets where id = $1', [sourceAssetId]);
    await db.query('delete from content_projects where id in ($1, $2)', [project.id, foreign.id]);
    await db.end();
    await rm(root, { recursive: true, force: true });
  }
});
