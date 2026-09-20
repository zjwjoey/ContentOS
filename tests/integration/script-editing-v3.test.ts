import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createDatabase, migrateUp, resolveMigrationsDirectory } from '../../packages/database/src/index.js';
import { JianyingDraftImporter, ScriptEditingV3Service } from '../../packages/modules/video/src/index.js';

const adminUrl = process.env.CONTENTOS_TEST_ADMIN_DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test';

async function withDatabase<T>(run: (db: pg.Pool, workspaceId: string, rootId: string) => Promise<T>): Promise<T> {
  const schema = `contentos_v3_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const admin = new pg.Pool({ connectionString: adminUrl });
  const tempDirectory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'contentos-v3-migrations-'));
  await admin.query(`create schema "${schema}"`);
  const schemaUrl = new URL(adminUrl);
  schemaUrl.searchParams.set('options', `-c search_path=${schema}`);
  try {
    const entries = await readdir(resolveMigrationsDirectory());
    await Promise.all(entries.filter((entry) => /^\d+_.+\.sql$/u.test(entry) && !entry.endsWith('.down.sql')).map((entry) => copyFile(join(resolveMigrationsDirectory(), entry), join(tempDirectory, entry))));
    const db = await createDatabase(schemaUrl.toString());
    try {
      await migrateUp(db, tempDirectory);
      const workspaceId = `v3-workspace-${randomUUID()}`;
      const rootId = `v3-root-${randomUUID()}`;
      await db.query("insert into video_workspaces (id,type,project_id) values ($1,'STANDALONE',null)", [workspaceId]);
      return await run(db, workspaceId, rootId);
    } finally { await db.end(); }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
}

async function insertMedia(db: pg.Pool, workspaceId: string, rootId: string, fileId: string, sourcePath: string, fileName: string, durationMs: number): Promise<void> {
  const scanId = `v3-scan-${randomUUID()}`;
  await db.query("insert into local_media_scans (id,workspace_id,source_root,source_root_id,recursive,status,scanned_at) values ($1,$2,$3,$4,true,'SUCCEEDED',now())", [scanId, workspaceId, 'F:/media', rootId]);
  await db.query("insert into local_media_scan_files (scan_id,file_id,file_name,relative_path,source_path,duration_ms,width,height,format,available,orientation,file_size,modified_at,tags,thumbnail_status) values ($1,$2,$3,$4,$5,$6,1920,1080,'mp4',true,'HORIZONTAL',100,$7,'[]','PENDING')", [scanId, fileId, fileName, fileName, sourcePath, durationMs, new Date('2026-01-01T00:00:00Z')]);
  await db.query("insert into local_media_index (file_id,source_root_id,relative_path,file_name,duration_ms,width,height,orientation,format,file_size,modified_at,tags,availability,thumbnail_status) values ($1,$2,$3,$4,$5,1920,1080,'HORIZONTAL','mp4',100,$6,'[]','AVAILABLE','PENDING')", [fileId, rootId, fileName, fileName, durationMs, new Date('2026-01-01T00:00:00Z')]);
}

test('V3 database workflow freezes pools, reuses Assets, and preserves locked clips', async () => {
  await withDatabase(async (db, workspaceId, rootId) => {
    const fileId = `${rootId}:clip.mp4`;
    const secondFileId = `${rootId}:second.mp4`;
    await insertMedia(db, workspaceId, rootId, fileId, 'F:/media/clip.mp4', 'clip.mp4', 5_000);
    await insertMedia(db, workspaceId, rootId, secondFileId, 'F:/media/second.mp4', 'second.mp4', 5_000);
    const service = new ScriptEditingV3Service(db);
    const snapshot = await service.createMaterialPoolSnapshot({ workspaceId, sourceRootIds: [rootId] });
    assert.deepEqual(snapshot.items.map((item) => item.assetId).sort(), [fileId, secondFileId].sort());

    await insertMedia(db, workspaceId, rootId, `${rootId}:new.mp4`, 'F:/media/new.mp4', 'new.mp4', 5_000);
    assert.equal((await service.getSnapshot(snapshot.id)).items.length, 2);

    await db.query("insert into asset_visual_profiles (asset_id,summary,profile,provider,model_name,model_version,prompt_version,analysis_version,status) values ($1,$2,$3,'QWEN_VL','qwen','1','p','1','READY')", [fileId, '门店内部与货架', { assetId: fileId, summary: '门店内部与货架', tags: [{ tag: '货架', confidence: .9, timestampsMs: [1000] }], recommendedTimestampsMs: [1000], modelProvider: 'QWEN_VL', modelName: 'qwen', modelVersion: '1', promptVersion: 'p', analysisVersion: '1', createdAt: new Date().toISOString() }]);
    const session = await service.createSession({ workspaceId, snapshotId: snapshot.id, script: '顾客在货架购物。' });
    const generated = await service.generate(session.id);
    assert.ok(generated.manifestId);
    const initial = await service.getSession(session.id);
    assert.equal(initial.cards[0]?.clip?.durationMs, 3_000);
    assert.ok((initial.cards[0]?.candidates || []).some((candidate) => candidate.assetId === fileId));

    await service.applyOperation(session.id, { type: 'TRIM_SOURCE', sentenceId: 'sentence-0', sourceInMs: 1_000, sourceOutMs: 4_000 });
    await service.applyOperation(session.id, { type: 'LOCK_CLIP', sentenceId: 'sentence-0' });
    const lockedBefore = (await service.getSession(session.id)).cards[0]?.clip;
    await service.generate(session.id);
    const lockedAfter = (await service.getSession(session.id)).cards[0]?.clip;
    assert.deepEqual(lockedAfter, lockedBefore);

    await assert.rejects(service.applyOperation(session.id, { type: 'MANUAL_SELECT_CLIP', sentenceId: 'sentence-0', assetId: secondFileId }), /SCRIPT_EDITING_V3_CLIP_LOCKED/);
    await service.applyOperation(session.id, { type: 'UNLOCK_CLIP', sentenceId: 'sentence-0' });
    await service.applyOperation(session.id, { type: 'MANUAL_SELECT_CLIP', sentenceId: 'sentence-0', assetId: secondFileId });
    const manuallySelected = (await service.getSession(session.id)).cards[0]?.clip;
    assert.equal(manuallySelected?.assetId, secondFileId);
    const stats = (await db.query<{ candidate_count: number; manual_select_count: number }>('select candidate_count,manual_select_count from script_editing_v3_asset_usage_stats where workspace_id=$1 and asset_id=$2', [workspaceId, secondFileId])).rows[0];
    assert.ok(Number(stats?.candidate_count) >= 1);
    assert.equal(Number(stats?.manual_select_count), 1);
  });
});

test('Jianying directory import is read-only and maps history back to the existing Asset', async () => {
  const draftDirectory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'contentos-v3-jianying-'));
  try {
    await writeFile(join(draftDirectory, 'draft_content.json'), JSON.stringify({ draft_id: 'draft-1', draft_name: '历史草稿', materials: [{ material_id: 'material-1', path: 'F:/media/clip.mp4' }], tracks: [{ segments: [{ material_id: 'material-1', source_timerange: { start: 1_000_000, duration: 3_000_000 }, target_timerange: { start: 0, duration: 3_000_000 } }] }] }));
    await withDatabase(async (db, workspaceId, rootId) => {
      const fileId = `${rootId}:clip.mp4`;
      await insertMedia(db, workspaceId, rootId, fileId, resolve('F:/media/clip.mp4'), 'clip.mp4', 5_000);
      const imported = await new JianyingDraftImporter(db).importReadOnly(workspaceId, draftDirectory);
      assert.equal(imported.usageCount, 1);
      const snapshot = await new ScriptEditingV3Service(db).createMaterialPoolSnapshot({ workspaceId, sourceKind: 'JIANYING_DRAFT' });
      assert.deepEqual(snapshot.items.map((item) => item.assetId), [fileId]);
      const usage = (await db.query<{ source_in_ms: number; source_out_ms: number }>('select source_in_ms,source_out_ms from jianying_asset_usages where draft_import_id=$1', [imported.id])).rows[0];
      assert.deepEqual(usage, { source_in_ms: 1_000, source_out_ms: 4_000 });
    });
  } finally { await rm(draftDirectory, { recursive: true, force: true }); }
});
