import type { Pool } from 'pg';

export interface CurrentRenderSummary {
  renderId: string;
  outputAssetId: string;
}

export interface RenderHistorySummary {
  renderId: string;
  outputAssetId?: string;
  status: string;
  createdAt: string;
  jobId?: string;
}

export interface VideoJobProgressSummary {
  id: string;
  state: string;
  attemptCount: number;
  maxAttempts: number;
  errorCode?: string;
  errorMessage?: string;
}

function safeError(value: unknown): { code?: string; message?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
  };
}

export class VideoProjectReadService {
  constructor(private readonly db: Pool) {}

  async getCurrentRender(projectId: string): Promise<CurrentRenderSummary | null> {
    const result = await this.db.query<{ id: string; output_asset_id: string }>("select r.id, r.output_asset_id from renders r join edit_manifests m on m.id = r.manifest_id and m.project_id = r.project_id where r.project_id = $1 and r.status = 'SUCCEEDED' and r.output_asset_id is not null and m.status = 'PERSISTED' order by m.revision desc, r.finished_at desc nulls last, r.id desc limit 1", [projectId]);
    const row = result.rows[0];
    return row ? { renderId: String(row.id), outputAssetId: String(row.output_asset_id) } : null;
  }

  async listRenderHistory(projectId: string, limit = 20): Promise<RenderHistorySummary[]> {
    const result = await this.db.query('select r.id, r.output_asset_id, r.status, r.created_at, r.job_id from renders r join edit_manifests m on m.id = r.manifest_id and m.project_id = r.project_id where r.project_id = $1 order by r.created_at desc, r.id desc limit $2', [projectId, Math.min(Math.max(limit, 1), 50)]);
    return result.rows.map((row) => ({
      renderId: String(row.id),
      ...(row.output_asset_id ? { outputAssetId: String(row.output_asset_id) } : {}),
      status: String(row.status),
      createdAt: new Date(String(row.created_at)).toISOString(),
      ...(row.job_id ? { jobId: String(row.job_id) } : {}),
    }));
  }

  async getLatestVideoJob(projectId: string): Promise<VideoJobProgressSummary | null> {
    const result = await this.db.query("select id, state, attempt_count, max_attempts, error from jobs where project_id = $1 and type = 'VIDEO_RENDER' order by created_at desc, id desc limit 1", [projectId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const error = safeError(row.error);
    return {
      id: String(row.id), state: String(row.state), attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts),
      ...(error.code ? { errorCode: error.code } : {}), ...(error.message ? { errorMessage: error.message } : {}),
    };
  }
}
