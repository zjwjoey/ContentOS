import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { AssetCatalogService } from '../../packages/modules/asset/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { VideoAdjustmentService, StandaloneQuickEditService, VideoService } from '../../packages/modules/video/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';

test('Standalone Quick Edit plans and adjusts without creating a Content Project', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const suffix = randomUUID(); const assets = new AssetCatalogService(db); const jobs = new JobService(db); const adjustment = new VideoAdjustmentService(db, assets); const video = new VideoService(db, jobs, assets); const standalone = new StandaloneQuickEditService(db, assets, adjustment, video);
    const assetIds = [`standalone-a-${suffix}`, `standalone-b-${suffix}`, `standalone-c-${suffix}`]; const voiceId = `standalone-voice-${suffix}`; const secondVoiceId = `standalone-voice-b-${suffix}`; let workspaceId = '';
  try {
    for (const [index, id] of assetIds.entries()) await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, null, $2, $3, $4, $5, $6, $7)', [id, 'VIDEO', `sha256:${id}`, 100, `standalone/${id}.mp4`, 'READY', { durationMs: 8_000, originalName: `${index}.mp4` }]);
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, null, $2, $3, $4, $5, $6, $7)', [voiceId, 'AUDIO', `sha256:${voiceId}`, 100, `standalone/${voiceId}.wav`, 'READY', { durationMs: 30_000, originalName: 'voice.wav' }]);
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, null, $2, $3, $4, $5, $6, $7)', [secondVoiceId, 'AUDIO', `sha256:${secondVoiceId}`, 100, `standalone/${secondVoiceId}.wav`, 'READY', { durationMs: 25_000, originalName: 'voice-b.wav' }]);
    const session = await standalone.create({ sourceAssetIds: assetIds, voiceAssetId: voiceId, seed: 11 }); workspaceId = session.workspaceId;
    const configured = await standalone.updateSettings(session.id, { seed: 17, targetDurationMs: null, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 });
    assert.equal(configured.seed, 17); assert.equal(configured.targetDurationMs, null); assert.equal(configured.maxClipDurationMs, 5_000);
    assert.equal((await db.query('select count(*)::int as count from content_projects where id = $1', [session.workspaceId])).rows[0]?.count, 0);
    const first = await standalone.plan(session.id); assert.equal(first.workspaceId, session.workspaceId); assert.equal(first.projectId, ''); assert.equal(first.manifest.timeline.reduce((sum, clip) => sum + clip.durationMs, 0), 30_000);
    await assert.rejects(() => standalone.setVoiceAsset(session.id, secondVoiceId), /STANDALONE_PLANNER_LOCKED/);
    const voiceLockedSession = await standalone.get(session.id); assert.equal(voiceLockedSession?.voiceAssetId, voiceId); assert.equal(voiceLockedSession?.currentManifestId, first.id);
    const second = await standalone.plan(session.id); assert.equal(second.id, first.id);
    const revised = await standalone.adjust(session.id, [{ type: 'REROLL', clipIndex: 0, seed: 4 }]); assert.equal(revised.revision, 2); assert.equal(revised.parentManifestId, first.id);
    const currentAfterFirstAdjustment = await standalone.get(session.id); assert.equal(currentAfterFirstAdjustment?.currentManifestId, revised.id);
    const revisedAgain = await standalone.adjust(session.id, [{ type: 'TRIM', clipIndex: 0, sourceInMs: 0, durationMs: revised.manifest.timeline[0]!.durationMs }]); assert.equal(revisedAgain.revision, 3); assert.equal(revisedAgain.parentManifestId, revised.id);
    await assert.rejects(() => standalone.updateSettings(session.id, { seed: 19 }), /STANDALONE_PLANNER_LOCKED/);
    const job = await standalone.render(session.id); assert.equal(job.projectId, null); assert.equal(job.workspaceId, session.workspaceId);
  } finally {
    if (workspaceId) {
      await db.query('delete from renders where workspace_id = $1', [workspaceId]);
      await db.query('update video_quick_edit_sessions set current_manifest_id = null where workspace_id = $1', [workspaceId]);
      await db.query('delete from edit_manifests where workspace_id = $1', [workspaceId]);
      await db.query('delete from jobs where workspace_id = $1', [workspaceId]);
      await db.query('delete from video_quick_edit_sessions where workspace_id = $1', [workspaceId]);
      await db.query('delete from video_workspace_assets where workspace_id = $1', [workspaceId]);
      await db.query('delete from video_workspaces where id = $1', [workspaceId]);
    }
    await db.query('delete from assets where id = any($1::text[])', [assetIds.concat(voiceId, secondVoiceId)]); await db.end();
  }
});
