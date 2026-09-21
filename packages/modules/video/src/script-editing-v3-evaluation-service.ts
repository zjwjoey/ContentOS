import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type EvaluationItemInput = { assetId: string; sourceFingerprint?: string | undefined; fileName: string; durationMs?: number | undefined; tags?: string[] | undefined; visualProfile?: unknown };
export type EvaluationQueryInput = { id: string; visualNeed: string; usableAssetIds: string[]; forbiddenAssetIds?: string[] | undefined; metadata?: Record<string, unknown> | undefined };
export type EvaluationJudgmentLabel = 'BEST' | 'USABLE' | 'UNUSABLE' | 'FORBIDDEN';
export type EvaluationJudgmentInput = { queryId: string; assetId: string; label: EvaluationJudgmentLabel; reason?: string | undefined; annotator: string };

function jsonArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }

export class ScriptEditingV3EvaluationService {
  constructor(private readonly db: Pool) {}

  async list(workspaceId: string): Promise<unknown[]> {
    const result = await this.db.query('select s.*, count(distinct i.id)::int as item_count, count(distinct q.id)::int as query_count from script_editing_v3_evaluation_sets s left join script_editing_v3_evaluation_items i on i.set_id=s.id left join script_editing_v3_evaluation_queries q on q.set_id=s.id where s.workspace_id=$1 group by s.id order by s.created_at desc, s.id desc', [workspaceId]);
    return result.rows.map((row) => ({ id: String(row.id), workspaceId: String(row.workspace_id), name: String(row.name), version: Number(row.version), snapshotId: row.snapshot_id ? String(row.snapshot_id) : null, status: String(row.status), itemCount: Number(row.item_count), queryCount: Number(row.query_count), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() }));
  }

  async get(id: string): Promise<{ id: string; workspaceId: string; name: string; version: number; snapshotId: string | null; status: string; items: unknown[]; queries: unknown[]; judgments: unknown[] } | null> {
    const set = (await this.db.query('select * from script_editing_v3_evaluation_sets where id=$1', [id])).rows[0] as Record<string, unknown> | undefined;
    if (!set) return null;
    const [items, queries, judgments] = await Promise.all([
      this.db.query('select * from script_editing_v3_evaluation_items where set_id=$1 order by asset_id', [id]),
      this.db.query('select * from script_editing_v3_evaluation_queries where set_id=$1 order by created_at,id', [id]),
      this.db.query('select * from script_editing_v3_evaluation_judgments where set_id=$1 order by query_id,asset_id,annotator', [id]),
    ]);
    return { id: String(set.id), workspaceId: String(set.workspace_id), name: String(set.name), version: Number(set.version), snapshotId: set.snapshot_id ? String(set.snapshot_id) : null, status: String(set.status), items: items.rows.map((row) => ({ assetId: String(row.asset_id), sourceFingerprint: row.source_fingerprint ? String(row.source_fingerprint) : undefined, fileName: String(row.file_name), durationMs: Number(row.duration_ms), tags: jsonArray(row.tags), visualProfile: row.visual_profile || undefined })), queries: queries.rows.map((row) => ({ id: String(row.id), visualNeed: String(row.visual_need), usableAssetIds: jsonArray(row.usable_asset_ids), forbiddenAssetIds: jsonArray(row.forbidden_asset_ids), metadata: row.metadata || {} })), judgments: judgments.rows.map((row) => ({ queryId: String(row.query_id), assetId: String(row.asset_id), label: String(row.label), reason: row.reason || null, annotator: String(row.annotator), createdAt: new Date(String(row.created_at)).toISOString() })) };
  }

  async judge(input: { setId: string; queryId: string; assetId: string; label: EvaluationJudgmentLabel; reason?: string | undefined; annotator: string }): Promise<unknown> {
    const query = await this.db.query('select 1 from script_editing_v3_evaluation_queries where id=$1 and set_id=$2', [input.queryId, input.setId]);
    if (!query.rowCount) throw new Error('EVALUATION_QUERY_NOT_FOUND');
    const item = await this.db.query('select 1 from script_editing_v3_evaluation_items where set_id=$1 and asset_id=$2', [input.setId, input.assetId]);
    if (!item.rowCount) throw new Error('EVALUATION_ASSET_NOT_FOUND');
    const result = await this.db.query('insert into script_editing_v3_evaluation_judgments (id,set_id,query_id,asset_id,label,reason,annotator) values ($1,$2,$3,$4,$5,$6,$7) on conflict (query_id,asset_id,annotator) do update set label=excluded.label,reason=excluded.reason returning *', [`judgment-${randomUUID()}`, input.setId, input.queryId, input.assetId, input.label, input.reason || null, input.annotator]);
    const row = result.rows[0] as Record<string, unknown>;
    return { queryId: String(row.query_id), assetId: String(row.asset_id), label: String(row.label), reason: row.reason || null, annotator: String(row.annotator) };
  }

  async importSet(input: { workspaceId: string; name: string; snapshotId?: string; idempotencyKey?: string | undefined; items: EvaluationItemInput[]; queries: EvaluationQueryInput[]; judgments?: EvaluationJudgmentInput[] | undefined }): Promise<NonNullable<Awaited<ReturnType<ScriptEditingV3EvaluationService['get']>>>> {
    if (input.items.length < 100 || input.items.length > 300) throw new Error('EVALUATION_ITEM_COUNT_INVALID');
    if (input.queries.length < 10 || input.queries.length > 20) throw new Error('EVALUATION_QUERY_COUNT_INVALID');
    const itemIds = new Set(input.items.map((item) => item.assetId));
    if (itemIds.size !== input.items.length || input.queries.some((query) => query.usableAssetIds.some((id) => !itemIds.has(id)) || (query.forbiddenAssetIds || []).some((id) => !itemIds.has(id)))) throw new Error('EVALUATION_REFERENCE_INVALID');
    if (input.judgments?.some((judgment) => !itemIds.has(judgment.assetId) || !input.queries.some((query) => query.id === judgment.queryId))) throw new Error('EVALUATION_JUDGMENT_REFERENCE_INVALID');
    if (input.idempotencyKey) { const existing = (await this.db.query("select id from script_editing_v3_evaluation_sets where workspace_id=$1 and metadata->>'idempotencyKey'=$2 order by created_at desc limit 1", [input.workspaceId, input.idempotencyKey])).rows[0] as { id?: string } | undefined; if (existing?.id) return (await this.get(existing.id))!; }
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const version = Number((await client.query<{ version: number }>('select coalesce(max(version),0)+1 as version from script_editing_v3_evaluation_sets where workspace_id=$1 and name=$2', [input.workspaceId, input.name])).rows[0]?.version || 1);
      const id = `v3-eval-${randomUUID()}`;
      await client.query('insert into script_editing_v3_evaluation_sets (id,workspace_id,name,version,snapshot_id,status,metadata) values ($1,$2,$3,$4,$5,\'READY\',$6)', [id, input.workspaceId, input.name.trim(), version, input.snapshotId || null, JSON.stringify(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})]);
      for (const item of input.items) await client.query('insert into script_editing_v3_evaluation_items (id,set_id,asset_id,source_fingerprint,file_name,duration_ms,tags,visual_profile) values ($1,$2,$3,$4,$5,$6,$7,$8)', [`v3-eval-item-${randomUUID()}`, id, item.assetId, item.sourceFingerprint || null, item.fileName, Math.max(0, item.durationMs || 0), JSON.stringify(item.tags || []), item.visualProfile ? JSON.stringify(item.visualProfile) : null]);
      for (const query of input.queries) await client.query('insert into script_editing_v3_evaluation_queries (id,set_id,visual_need,usable_asset_ids,forbidden_asset_ids,metadata) values ($1,$2,$3,$4,$5,$6)', [query.id, id, query.visualNeed, JSON.stringify(query.usableAssetIds), JSON.stringify(query.forbiddenAssetIds || []), JSON.stringify(query.metadata || {})]);
      for (const judgment of input.judgments || []) await client.query('insert into script_editing_v3_evaluation_judgments (id,set_id,query_id,asset_id,label,reason,annotator) values ($1,$2,$3,$4,$5,$6,$7) on conflict (query_id,asset_id,annotator) do update set label=excluded.label,reason=excluded.reason', [`judgment-${randomUUID()}`, id, judgment.queryId, judgment.assetId, judgment.label, judgment.reason || null, judgment.annotator]);
      await client.query('commit');
      return (await this.get(id))!;
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }
}
