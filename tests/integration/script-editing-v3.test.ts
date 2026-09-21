import assert from 'node:assert/strict';
import { access, copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createDatabase, migrateUp, resolveMigrationsDirectory } from '../../packages/database/src/index.js';
import { generateFixtureVideo, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { AssetService } from '../../packages/modules/asset/src/index.js';
import { FakeExternalVideoProvider, HybridMediaService, JianyingDraftImporter, ScriptEditingV3Service } from '../../packages/modules/video/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { createDraftPreviewJobHandler } from '../../workers/video-worker/src/video-handler.js';

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
    const health = await service.getMaterialPoolHealth(snapshot.id);
    assert.equal(health.total, 2);
    assert.equal(health.missing, 2);
    assert.equal(health.aiNotRequested, 2);

    await service.setManualTags(snapshot.id, fileId, ['货架', 'MIZAN']);
    const originalFingerprint = snapshot.items.find((item) => item.assetId === fileId)?.sourceFingerprint;
    await service.persistVisualProfile({ assetId: fileId, summary: '门店内部', tags: [{ tag: '门店内部', confidence: .9, timestampsMs: [1_000] }], recommendedTimestampsMs: [1_000], modelProvider: 'QWEN_VL', modelName: 'qwen', modelVersion: '1', promptVersion: 'p', analysisVersion: '1', createdAt: new Date().toISOString() }, originalFingerprint);
    await service.persistVisualProfile({ assetId: fileId, summary: '门店内部更新', tags: [{ tag: '商品特写', confidence: .8, timestampsMs: [2_000] }], recommendedTimestampsMs: [2_000], modelProvider: 'QWEN_VL', modelName: 'qwen', modelVersion: '1', promptVersion: 'p', analysisVersion: '1', createdAt: new Date().toISOString() }, originalFingerprint);
    const evidence = (await db.query<{ tag: string; evidence_kind: string }>('select tag,evidence_kind from asset_tag_evidence where asset_id=$1 order by evidence_kind,tag', [fileId])).rows;
    assert.deepEqual(evidence, [{ tag: '货架', evidence_kind: 'MANUAL' }, { tag: '商品特写', evidence_kind: 'QWEN_VL' }]);
    assert.equal((await db.query('select count(*) from asset_visual_profiles where asset_id=$1', [fileId])).rows[0]?.count, '1');
    assert.equal((await db.query("select count(*) from asset_tag_evidence where asset_id=$1 and evidence_kind='QWEN_VL'", [fileId])).rows[0]?.count, '1');
    assert.deepEqual((await service.getSnapshot(snapshot.id)).items.find((item) => item.assetId === fileId)?.tags.sort(), ['货架']);
    assert.equal((await service.getMaterialPoolHealth(snapshot.id)).aiReady, 1);

    await db.query("update local_media_scan_files set modified_at='2026-01-02T00:00:00Z' where file_id=$1", [fileId]);
    await db.query("update local_media_index set modified_at='2026-01-02T00:00:00Z' where file_id=$1", [fileId]);
    const changedSnapshot = await service.createMaterialPoolSnapshot({ workspaceId, sourceRootIds: [rootId] });
    assert.notEqual(changedSnapshot.items.find((item) => item.assetId === fileId)?.sourceFingerprint, originalFingerprint);
    assert.equal((await service.getMaterialPoolHealth(changedSnapshot.id)).aiReady, 0);

    await insertMedia(db, workspaceId, rootId, `${rootId}:new.mp4`, 'F:/media/new.mp4', 'new.mp4', 5_000);
    assert.equal((await service.getSnapshot(snapshot.id)).items.length, 2);

    const session = await service.createSession({ workspaceId, snapshotId: snapshot.id, script: '顾客在货架购物。' });
    const generated = await service.generate(session.id);
    assert.ok(generated.manifestId);
    const firstManifest = (await db.query<{ manifest: Record<string, unknown>; manifest_digest: string }>('select manifest,manifest_digest from edit_manifests where id=$1', [generated.manifestId])).rows[0];
    const sourceSegment = (await db.query<{ asset_id: string; source_in_ms: number; source_out_ms: number }>('select asset_id,source_in_ms,source_out_ms from source_segments where snapshot_id=$1', [snapshot.id])).rows[0];
    assert.equal(sourceSegment?.asset_id, fileId);
    assert.equal(Number(sourceSegment?.source_out_ms) - Number(sourceSegment?.source_in_ms), 3_000);
    const initial = await service.getSession(session.id);
    assert.equal(initial.cards[0]?.clip?.durationMs, 3_000);
    assert.ok(initial.cards[0]?.candidates[0]?.sourceSegmentId);
    assert.ok(Number.isFinite(initial.cards[0]?.candidates[0]?.recommendedTimestampMs));
    assert.ok((initial.cards[0]?.candidates || []).some((candidate) => candidate.assetId === fileId));

    const regenerated = await service.generate(session.id);
    const secondManifest = (await db.query<{ manifest: Record<string, unknown>; manifest_digest: string }>('select manifest,manifest_digest from edit_manifests where id=$1', [regenerated.manifestId])).rows[0];
    assert.deepEqual(secondManifest?.manifest, firstManifest?.manifest);
    assert.equal(secondManifest?.manifest_digest, firstManifest?.manifest_digest);

    const initialClip = initial.cards[0]?.clip;
    assert.ok(initialClip);
    await service.applyOperation(session.id, { type: 'MANUAL_SELECT_CLIP', sentenceId: 'sentence-0', assetId: fileId, sourceInMs: initialClip.sourceInMs, sourceSegmentId: 'manual-same-range' });
    const sameRangeSegments = (await db.query('select count(*) from source_segments where snapshot_id=$1 and asset_id=$2 and source_in_ms=$3 and source_out_ms=$4', [snapshot.id, fileId, initialClip.sourceInMs, initialClip.sourceOutMs])).rows[0]?.count;
    assert.equal(sameRangeSegments, '1');

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

test('V3 uses the existing Hybrid/Pexels fallback only after local candidates are exhausted', async () => {
  const root = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'contentos-v3-hybrid-'));
  try {
    const localPath = join(root, 'too-short.mp4');
    const externalFixture = join(root, 'external-fixture.mp4');
    await generateFixtureVideo(localPath, process.env.FFMPEG_PATH || 'ffmpeg', 'blue', 1);
    await generateFixtureVideo(externalFixture, process.env.FFMPEG_PATH || 'ffmpeg', 'green', 6);
    await withDatabase(async (db, workspaceId) => {
      const storage = new LocalStorageProvider(join(root, 'storage'));
      const assets = new AssetService(db, storage, async (path) => probeMedia(path, process.env.FFPROBE_PATH || 'ffprobe'));
      const provider = new FakeExternalVideoProvider(externalFixture);
      const hybrid = new HybridMediaService(assets, storage, provider, db);
      const service = new ScriptEditingV3Service(db, { hybridMedia: hybrid, storage });
      const snapshot = await service.createMaterialPoolSnapshot({ workspaceId, sourceFiles: [localPath] });
      const session = await service.createSession({ workspaceId, snapshotId: snapshot.id, script: '商业合作正在推进。', settings: { usePexels: true }, sentences: [{ text: '商业合作正在推进', durationMs: 3_000 }] });
      await service.generate(session.id);
      const manifest = (await db.query<{ manifest: { timeline: Array<{ assetId: string; sourcePath: string; matching?: { selectedSource?: string } }> } }>('select manifest from edit_manifests join script_editing_v3_sessions on current_manifest_id=edit_manifests.id where script_editing_v3_sessions.id=$1', [session.id])).rows[0]?.manifest;
      const clip = manifest?.timeline[0];
      assert.equal(clip?.matching?.selectedSource, 'FAKE_PEXELS');
      assert.ok(clip?.assetId && !snapshot.items.some((item) => item.assetId === clip.assetId));
      assert.ok(clip?.sourcePath && !clip.sourcePath.startsWith('https://'));
      assert.equal((await db.query('select count(*) from external_media_assets where asset_id=$1', [clip?.assetId])).rows[0]?.count, '1');
      assert.equal((await service.getSession(session.id)).cards[0]?.asset?.assetId, clip?.assetId);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('V3 preserves confirmed voice absolute timing when ranking and compiling clips', async () => {
  await withDatabase(async (db, workspaceId, rootId) => {
    const fileId = `${rootId}:timed.mp4`;
    await insertMedia(db, workspaceId, rootId, fileId, 'F:/media/timed.mp4', 'timed.mp4', 8_000);
    const service = new ScriptEditingV3Service(db);
    const snapshot = await service.createMaterialPoolSnapshot({ workspaceId, sourceRootIds: [rootId] });
    const session = await service.createSession({ workspaceId, snapshotId: snapshot.id, script: '第一句。', voicePath: 'F:/voice/confirmed.wav', settings: { template: 'NEWS', presentationSettings: { canvas: { aspectRatio: '16:9', width: 1920, height: 1080, fps: 25, fitMode: 'CONTAIN' } } }, sentences: [{ text: '第一句', startMs: 1_200, endMs: 4_400, durationMs: 3_200 }] });
    await service.generate(session.id);
    const card = (await service.getSession(session.id)).cards[0]!;
    assert.equal(card.startMs, 1_200);
    assert.equal(card.endMs, 4_400);
    assert.equal(card.clip?.durationMs, 3_200);
    assert.equal(card.clip?.timelineStartMs, 1_200);
    const manifest = (await db.query<{ manifest: { canvas: { aspectRatio: string; width: number }; audio?: { voicePath?: string }; plannerVersion?: string; timeline: Array<{ voiceStartMs?: number; voiceEndMs?: number; sceneId?: string; timelineStartMs?: number; timelineEndMs?: number }> } }>('select manifest from edit_manifests join script_editing_v3_sessions on current_manifest_id=edit_manifests.id where script_editing_v3_sessions.id=$1', [session.id])).rows[0]?.manifest;
    assert.equal(manifest?.audio?.voicePath, 'F:/voice/confirmed.wav');
    assert.equal(manifest?.timeline[0]?.voiceStartMs, 1_200);
    assert.equal(manifest?.timeline[0]?.voiceEndMs, 4_400);
    assert.equal(manifest?.timeline[0]?.sceneId, 'scene-1');
    assert.deepEqual(manifest?.timeline[0] && { timelineStartMs: manifest.timeline[0].timelineStartMs, timelineEndMs: manifest.timeline[0].timelineEndMs }, { timelineStartMs: 1_200, timelineEndMs: 4_400 });
    assert.deepEqual(manifest && { aspectRatio: manifest.canvas.aspectRatio, width: manifest.canvas.width }, { aspectRatio: '16:9', width: 1920 });
  });
});

test('V3 can build a material snapshot from explicitly selected video files without copying them', async () => {
  const sourceDirectory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'contentos-v3-selected-video-'));
  try {
    const sourcePath = join(sourceDirectory, 'selected.mp4');
    await generateFixtureVideo(sourcePath, process.env.FFMPEG_PATH || 'ffmpeg', 'blue', 5);
    await withDatabase(async (db, workspaceId) => {
      const service = new ScriptEditingV3Service(db);
      const snapshot = await service.createMaterialPoolSnapshot({ workspaceId, sourceFiles: [sourcePath] });
      assert.equal(snapshot.items.length, 1);
      assert.equal(snapshot.items[0]?.sourcePath, sourcePath);
      assert.equal(snapshot.items[0]?.availability, 'VALID');
      assert.ok((snapshot.items[0]?.fps || 0) > 0);
      assert.match(snapshot.items[0]?.codec || '', /h264/i);
      assert.equal((await service.getMaterialPoolHealth(snapshot.id)).valid, 1);
      const secondSnapshot = await service.createMaterialPoolSnapshot({ workspaceId, sourceFiles: [sourcePath] });
      assert.equal(secondSnapshot.items[0]?.assetId, snapshot.items[0]?.assetId);
    });
  } finally { await rm(sourceDirectory, { recursive: true, force: true }); }
});

test('V3.4 draft preview renders fragments and reuses the unchanged fragment after a replacement', async () => {
  const root = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'contentos-v3-preview-'));
  try {
    const firstPath = join(root, 'first.mp4');
    const secondPath = join(root, 'second.mp4');
    const replacementPath = join(root, 'replacement.mp4');
    await generateFixtureVideo(firstPath, process.env.FFMPEG_PATH || 'ffmpeg', 'blue', 5);
    await generateFixtureVideo(secondPath, process.env.FFMPEG_PATH || 'ffmpeg', 'green', 5);
    await generateFixtureVideo(replacementPath, process.env.FFMPEG_PATH || 'ffmpeg', 'red', 5);
    await withDatabase(async (db, workspaceId) => {
      const storage = new LocalStorageProvider(join(root, 'storage'));
      const service = new ScriptEditingV3Service(db);
      const snapshot = await service.createMaterialPoolSnapshot({ workspaceId, sourceFiles: [firstPath, secondPath, replacementPath] });
      const session = await service.createSession({ workspaceId, snapshotId: snapshot.id, script: '第一句。第二句。', sentences: [{ text: '第一句', durationMs: 3_000 }, { text: '第二句', durationMs: 3_000 }] });
      await service.generate(session.id);
      const firstManifest = (await db.query<{ id: string; manifest: Record<string, unknown> }>('select m.id,m.manifest from edit_manifests m join script_editing_v3_sessions s on s.current_manifest_id=m.id where s.id=$1', [session.id])).rows[0]!;
      const handler = createDraftPreviewJobHandler({ db, storage, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', ffprobePath: process.env.FFPROBE_PATH || 'ffprobe' } as never);
      const job = { id: 'preview-job-1', type: 'EDIT_V3_DRAFT_PREVIEW', payload: { sessionId: session.id, manifestId: firstManifest.id, snapshotId: snapshot.id, workspaceId, mode: 'DRAFT' } } as never;
      const firstResult = await handler(job, 'attempt-1', new AbortController().signal) as { renderedFragmentCount: number; reusedFragmentCount: number; outputPath: string };
      assert.equal(firstResult.renderedFragmentCount, 2);
      assert.equal(firstResult.reusedFragmentCount, 0);
      assert.equal((await access(firstResult.outputPath).then(() => true).catch(() => false)), true);
      assert.ok((await probeMedia(firstResult.outputPath, process.env.FFPROBE_PATH || 'ffprobe')).durationMs >= 5_500);
      const usedAssetIds = ((await db.query<{ manifest: { timeline: Array<{ assetId: string }> } }>('select manifest from edit_manifests where id=$1', [firstManifest.id])).rows[0]?.manifest.timeline || []).map((clip) => clip.assetId);
      const replacementAsset = snapshot.items.find((item) => !usedAssetIds.includes(item.assetId))!;
      await service.applyOperation(session.id, { type: 'REPLACE_CLIP', sentenceId: 'sentence-0', assetId: replacementAsset.assetId });
      const secondManifest = (await db.query<{ id: string }>('select current_manifest_id as id from script_editing_v3_sessions where id=$1', [session.id])).rows[0]!;
      const secondJob = { id: 'preview-job-2', type: 'EDIT_V3_DRAFT_PREVIEW', payload: { sessionId: session.id, manifestId: secondManifest.id, snapshotId: snapshot.id, workspaceId, mode: 'DRAFT' } } as never;
      const secondResult = await handler(secondJob, 'attempt-2', new AbortController().signal) as { renderedFragmentCount: number; reusedFragmentCount: number };
      assert.equal(secondResult.renderedFragmentCount, 1);
      assert.equal(secondResult.reusedFragmentCount, 1);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('V3.4 relink preserves material identity and rejects an unconfirmed different file', async () => {
  const root = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'contentos-v3-relink-'));
  try {
    const originalPath = join(root, 'original.mp4');
    const movedPath = join(root, 'moved.mp4');
    const differentPath = join(root, 'different.mp4');
    await generateFixtureVideo(originalPath, process.env.FFMPEG_PATH || 'ffmpeg', 'blue', 5);
    await copyFile(originalPath, movedPath);
    await generateFixtureVideo(differentPath, process.env.FFMPEG_PATH || 'ffmpeg', 'red', 5);
    await withDatabase(async (db, workspaceId) => {
      const service = new ScriptEditingV3Service(db);
      const snapshot = await service.createMaterialPoolSnapshot({ workspaceId, sourceFiles: [originalPath] });
      const item = snapshot.items[0]!;
      await service.setManualTags(snapshot.id, item.assetId, ['货架']);
      await service.setGold(snapshot.id, item.assetId, true);
      await db.query('insert into script_editing_v3_asset_usage_stats (workspace_id,asset_id,selected_count) values ($1,$2,3) on conflict (workspace_id,asset_id) do update set selected_count=3', [workspaceId, item.assetId]);
      const relinked = await service.relinkMaterial(snapshot.id, item.assetId, movedPath);
      assert.equal(relinked.assetId, item.assetId);
      assert.equal(relinked.confidence, 'HIGH');
      const after = (await service.getSnapshot(snapshot.id)).items[0]!;
      assert.equal(after.sourcePath, movedPath);
      assert.deepEqual(after.tags, ['货架']);
      assert.equal(after.gold, true);
      assert.equal(after.selectedCount, 3);
      await assert.rejects(service.relinkMaterial(snapshot.id, item.assetId, differentPath), /RELINK_CONFIRMATION_REQUIRED/);
      const forced = await service.relinkMaterial(snapshot.id, item.assetId, differentPath, 'operator', true);
      assert.equal(forced.assetId, item.assetId);
      assert.equal(forced.confidence, 'FORCED');
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Jianying directory import is read-only and maps history back to the existing Asset', async () => {
  const draftDirectory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'contentos-v3-jianying-'));
  const secondDraftDirectory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'contentos-v3-jianying-2-'));
  try {
    await writeFile(join(draftDirectory, 'draft_content.json'), JSON.stringify({ draft_id: 'draft-1', draft_name: '历史草稿', materials: [{ material_id: 'material-1', path: 'F:/media/clip.mp4' }], tracks: [{ segments: [{ material_id: 'material-1', source_timerange: { start: 1_000_000, duration: 3_000_000 }, target_timerange: { start: 0, duration: 3_000_000 } }] }] }));
    await writeFile(join(secondDraftDirectory, 'draft_content.json'), JSON.stringify({ draft_id: 'draft-2', draft_name: '第二份历史草稿', materials: [{ material_id: 'material-2', path: 'F:/media/clip.mp4' }], tracks: [{ segments: [{ material_id: 'material-2', source_timerange: { start: 2_000_000, duration: 2_000_000 }, target_timerange: { start: 0, duration: 2_000_000 } }] }] }));
    await withDatabase(async (db, workspaceId, rootId) => {
      const fileId = `${rootId}:clip.mp4`;
      await insertMedia(db, workspaceId, rootId, fileId, resolve('F:/media/clip.mp4'), 'clip.mp4', 5_000);
      const importer = new JianyingDraftImporter(db);
      const imported = await importer.importReadOnly(workspaceId, draftDirectory);
      const importedAgain = await importer.importReadOnly(workspaceId, secondDraftDirectory);
      assert.equal(imported.usageCount, 1);
      assert.equal(importedAgain.usageCount, 1);
      const snapshot = await new ScriptEditingV3Service(db).createMaterialPoolSnapshot({ workspaceId, sourceKind: 'JIANYING_DRAFT' });
      assert.deepEqual(snapshot.items.map((item) => item.assetId), [fileId]);
      assert.equal(snapshot.items[0]?.jianyingUseCount, 2);
      assert.equal((await db.query('select count(*) from jianying_asset_usages where asset_id=$1', [resolve('F:/media/clip.mp4')])).rows[0]?.count, '2');
      const usage = (await db.query<{ source_in_ms: number; source_out_ms: number }>('select source_in_ms,source_out_ms from jianying_asset_usages where draft_import_id=$1', [imported.id])).rows[0];
      assert.deepEqual(usage, { source_in_ms: 1_000, source_out_ms: 4_000 });
    });
  } finally { await rm(draftDirectory, { recursive: true, force: true }); await rm(secondDraftDirectory, { recursive: true, force: true }); }
});
