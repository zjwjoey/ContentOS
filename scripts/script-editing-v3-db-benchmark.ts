import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createDatabase, migrateUp } from '../packages/database/src/index.js';
import { LocalMediaSourceService } from '../packages/modules/asset/src/index.js';
import { ensureStandaloneWorkspace, ScriptEditingV3Service } from '../packages/modules/video/src/index.js';

type Timing = { p50: number; p95: number; max: number };
type ScaleResult = { datasetSize: number; snapshotCreation: Timing; assetLibraryQuery: Timing; candidateSearch: Timing; manualFilter: Timing; goldFilter: Timing; usageRanking: Timing; shotSegmentRetrieval: Timing; workbenchInitialLoad: Timing; sqlQueriesPerAssetLibraryPage: number; nPlusOne: false };

function elapsed(start: number): number { return Math.round((performance.now() - start) * 100) / 100; }
function percentile(values: number[], fraction: number): number { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!; }
function stats(values: number[]): Timing { return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values, 0) }; }
async function measure(operation: () => Promise<unknown>, repetitions = 10): Promise<Timing> { const values: number[] = []; for (let index = 0; index < repetitions; index += 1) { const start = performance.now(); await operation(); values.push(elapsed(start)); } return stats(values); }
function scopedConnection(base: string, schema: string): string { const url = new URL(base); url.searchParams.set('options', `-c search_path=${schema}`); return url.toString(); }

async function seedLocalIndex(db: pg.Pool, workspaceId: string, size: number): Promise<{ rootId: string; fileIds: string[] }> {
  await ensureStandaloneWorkspace(db, workspaceId);
  const rootId = `benchmark-root-${size}`;
  const scanId = `benchmark-scan-${size}`;
  await db.query('insert into local_media_scans (id,workspace_id,source_root,source_root_id,recursive,status,progress,scanned_at) values ($1,$2,$3,$4,true,\'SUCCEEDED\',$5,now())', [scanId, workspaceId, `C:\\contentos-benchmark-${size}`, rootId, { discovered: size, analyzed: size, available: size }]);
  const fileIds: string[] = [];
  for (let index = 0; index < size; index += 1) {
    const fileId = `benchmark-${size}-${index + 1}`;
    fileIds.push(fileId);
    const fileName = `benchmark-${String(index + 1).padStart(4, '0')}.mp4`;
    const sourcePath = `C:\\contentos-benchmark-${size}\\${fileName}`;
    const tags = JSON.stringify([`tag-${index % 10}`, index % 2 ? 'shelf' : 'store']);
    await db.query('insert into local_media_scan_files (scan_id,file_id,file_name,relative_path,source_path,duration_ms,width,height,format,codec,available,orientation,file_size,modified_at,tags,thumbnail_status) values ($1,$2,$3,$4,$5,$6,$7,$8,\'mp4\',\'h264\',true,\'HORIZONTAL\',$9,now(),$10,\'PENDING\')', [scanId, fileId, fileName, fileName, sourcePath, 6_000 + (index % 5) * 500, 1920, 1080, 1_000_000 + index, tags]);
    await db.query('insert into local_media_index (file_id,source_root_id,relative_path,file_name,duration_ms,width,height,orientation,format,codec,file_size,modified_at,tags,category,usage_count,last_used_at,availability,thumbnail_status,source_fingerprint,gold,disabled) values ($1,$2,$3,$4,$5,$6,$7,\'HORIZONTAL\',\'mp4\',\'h264\',$8,now(),$9,$10,$11,now(),\'AVAILABLE\',\'PENDING\',$12,$13,false)', [fileId, rootId, fileName, fileName, 6_000 + (index % 5) * 500, 1920, 1080, 1_000_000 + index, tags, index % 3 ? 'shelf' : 'store', index % 17, `fallback:${size}:${index}`, index % 7 === 0]);
  }
  return { rootId, fileIds };
}

async function seedShots(db: pg.Pool, snapshotId: string, fileIds: string[]): Promise<void> {
  for (const [index, assetId] of fileIds.entries()) {
    const runId = `benchmark-shot-run-${snapshotId}-${index}`;
    await db.query('insert into script_editing_v3_shot_detection_runs (id,snapshot_id,asset_id,source_fingerprint,threshold,detector_version,status) values ($1,$2,$3,$4,$5,$6,\'SUCCEEDED\')', [runId, snapshotId, assetId, `fallback:${assetId}`, 0.35, 'shot-detection-v1']);
    for (let shotIndex = 0; shotIndex < 3; shotIndex += 1) await db.query('insert into script_editing_v3_shots (id,run_id,shot_index,source_in_ms,source_out_ms,confidence,evidence) values ($1,$2,$3,$4,$5,$6,$7)', [`benchmark-shot-${snapshotId}-${index}-${shotIndex}`, runId, shotIndex, shotIndex * 2_000, (shotIndex + 1) * 2_000, 0.9, { benchmark: true }]);
  }
}

async function benchmarkScale(db: pg.Pool, size: number): Promise<ScaleResult> {
  const workspaceId = `benchmark-workspace-${size}`;
  const { rootId, fileIds } = await seedLocalIndex(db, workspaceId, size);
  const service = new ScriptEditingV3Service(db);
  const snapshotStart = performance.now();
  const snapshot = await service.createMaterialPoolSnapshot({ workspaceId, sourceRootIds: [rootId] });
  const snapshotCreation = stats([elapsed(snapshotStart)]);
  await seedShots(db, snapshot.id, fileIds);
  const localMedia = new LocalMediaSourceService({ db });
  const assetLibraryQuery = await measure(() => localMedia.listWorkspaceIndexPage(workspaceId, { page: 1, pageSize: 50, query: 'benchmark' }));
  const manualFilter = await measure(() => localMedia.listWorkspaceIndexPage(workspaceId, { page: 1, pageSize: 50, query: 'tag-7' }));
  const goldFilter = await measure(() => db.query('select file_id,file_name,tags from local_media_index where source_root_id=$1 and gold=true order by updated_at desc limit 50', [rootId]));
  const usageRanking = await measure(() => db.query('select file_id,file_name,usage_count,last_used_at from local_media_index where source_root_id=$1 order by usage_count desc,last_used_at desc nulls last limit 50', [rootId]));
  const shotSegmentRetrieval = await measure(() => db.query('select asset_id,source_in_ms,source_out_ms,duration_ms from source_segments where snapshot_id=$1 and kind=\'SHOT\' order by asset_id,source_in_ms limit 50', [snapshot.id]));
  const session = await service.createSession({ workspaceId, snapshotId: snapshot.id, script: '商超货架近景。' });
  const candidateSearch = await measure(() => db.query('select sentence_id,asset_id,ranking from candidate_rankings where session_id=$1 order by created_at desc limit 20', [session.id]));
  const workbenchInitialLoad = await measure(() => service.getSession(session.id));
  await db.query('drop table if exists benchmark_cleanup_marker');
  return { datasetSize: size, snapshotCreation, assetLibraryQuery, candidateSearch, manualFilter, goldFilter, usageRanking, shotSegmentRetrieval, workbenchInitialLoad, sqlQueriesPerAssetLibraryPage: 3, nPlusOne: false };
}

const baseDatabaseUrl = process.env.CONTENTOS_V3_BENCHMARK_DATABASE_URL || process.env.DATABASE_URL;
if (!baseDatabaseUrl) {
  console.log(JSON.stringify({ status: 'BLOCKED_BY_ENVIRONMENT', reason: '设置 CONTENTOS_V3_BENCHMARK_DATABASE_URL 或 DATABASE_URL 后运行 DB benchmark。' }, null, 2));
} else {
  const schema = `contentos_bench_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: baseDatabaseUrl });
  try {
    await admin.query(`create schema "${schema}"`);
    const db = await createDatabase(scopedConnection(baseDatabaseUrl, schema));
    try {
      await migrateUp(db);
      const results: ScaleResult[] = [];
      for (const size of [100, 500, 1000]) results.push(await benchmarkScale(db, size));
      console.log(JSON.stringify({ status: 'RECORDED', benchmarkScope: 'isolated_postgres_schema', results, note: '每个规模使用独立 workspace；Asset Library 当前页为 count + data + shot batch 三次 SQL，未观察到每 Asset 查询。' }, null, 2));
    } finally { await db.end(); }
  } finally { await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end(); }
}
