import { writeFile } from 'node:fs/promises';
import { createDatabase } from '../packages/database/src/index.js';

type ExportRow = {
  asset_id: string;
  source_path: string;
  file_name: string;
  duration_ms: number;
  width: number;
  height: number;
  tags: unknown;
  profile: unknown;
};

function jsonArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

async function main(): Promise<void> {
  const databaseUrl = process.env.CONTENTOS_V3_DATABASE_URL || process.env.DATABASE_URL;
  const evaluationSetId = process.env.CONTENTOS_V3_EVALUATION_SET_ID;
  const snapshotId = process.env.CONTENTOS_V3_SNAPSHOT_ID || process.argv[2];
  const outputPath = process.env.CONTENTOS_V3_GOLD_SET_OUTPUT || process.argv[3];
  if (!databaseUrl || (!snapshotId && !evaluationSetId) || !outputPath) {
    console.log(JSON.stringify({ status: 'BLOCKED_BY_INPUT', reason: '需要 DATABASE_URL、Snapshot ID 和输出路径。用法：tsx scripts/script-editing-v3-gold-set-export.ts <snapshotId> <output.json>' }, null, 2));
    return;
  }

  const db = await createDatabase(databaseUrl);
  try {
    if (evaluationSetId) {
      const set = (await db.query<{ name: string; workspace_id: string }>('select name,workspace_id from script_editing_v3_evaluation_sets where id=$1', [evaluationSetId])).rows[0];
      if (!set) { console.log(JSON.stringify({ status: 'BLOCKED_BY_DATA', reason: 'Evaluation Set 不存在。', evaluationSetId }, null, 2)); return; }
      const [items, queries] = await Promise.all([
        db.query('select asset_id,file_name,duration_ms,tags,visual_profile,source_fingerprint from script_editing_v3_evaluation_items where set_id=$1 order by asset_id', [evaluationSetId]),
        db.query('select id,visual_need,usable_asset_ids,forbidden_asset_ids from script_editing_v3_evaluation_queries where set_id=$1 order by created_at,id', [evaluationSetId]),
      ]);
      const goldSet = { schemaVersion: 'SCRIPT_EDITING_V3_GOLD_SET_V1', evaluationSetId, name: set.name, items: items.rows.map((row) => ({ assetId: String(row.asset_id), fileName: String(row.file_name), durationMs: Number(row.duration_ms), tags: jsonArray(row.tags), ...(row.source_fingerprint ? { sourceFingerprint: String(row.source_fingerprint) } : {}), ...(row.visual_profile ? { visualProfile: row.visual_profile } : {}) })), queries: queries.rows.map((row) => ({ id: String(row.id), text: String(row.visual_need), usableAssetIds: jsonArray(row.usable_asset_ids), forbiddenAssetIds: jsonArray(row.forbidden_asset_ids) })) };
      await writeFile(outputPath, `${JSON.stringify(goldSet, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      console.log(JSON.stringify({ status: 'EXPORTED_FROM_DATABASE_TRUTH', outputPath, evaluationSetId, itemCount: items.rows.length, queryCount: queries.rows.length }, null, 2));
      return;
    }
    const result = await db.query<ExportRow>(`select i.asset_id, i.source_path, i.file_name, i.duration_ms, i.width, i.height, i.tags, p.profile
      from material_pool_items i
      join material_pool_snapshots s on s.id = i.snapshot_id
      left join asset_visual_profiles p on p.asset_id = i.asset_id and p.source_fingerprint = i.source_fingerprint and p.status = 'READY'
      where i.snapshot_id = $1 and i.availability = 'VALID' and i.disabled = false
      order by i.asset_id`, [snapshotId]);
    if (result.rows.length < 100 || result.rows.length > 300) {
      console.log(JSON.stringify({ status: 'BLOCKED_BY_DATA', reason: 'Snapshot 中必须有 100–300 条仍有效的素材；AI Profile 可后续配置后补齐。', snapshotId, itemCount: result.rows.length }, null, 2));
      return;
    }
    const items = result.rows.map((row) => ({
      assetId: row.asset_id,
      fileName: row.file_name,
      sourcePath: row.source_path,
      durationMs: Number(row.duration_ms),
      width: Number(row.width),
      height: Number(row.height),
      tags: jsonArray(row.tags),
      visualProfile: row.profile,
    }));
    const goldSet = {
      schemaVersion: 'SCRIPT_EDITING_V3_GOLD_SET_V1',
      snapshotId,
      items,
      queries: [],
    };
    await writeFile(outputPath, `${JSON.stringify(goldSet, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ status: 'EXPORTED_FOR_ANNOTATION', outputPath, snapshotId, itemCount: items.length, queryCount: 0, nextStep: '人工填写 10–20 条 queries 的 usableAssetIds/forbiddenAssetIds 后运行 script-editing-v3-ai-benchmark.ts' }, null, 2));
  } finally {
    await db.end();
  }
}

await main();
