import type { Pool } from 'pg';

export interface CurrentRenderSummary {
  renderId: string;
  outputAssetId: string;
}

export class VideoProjectReadService {
  constructor(private readonly db: Pool) {}

  async getCurrentRender(projectId: string): Promise<CurrentRenderSummary | null> {
    const result = await this.db.query<{ id: string; output_asset_id: string }>("select r.id, r.output_asset_id from renders r join edit_manifests m on m.id = r.manifest_id and m.project_id = r.project_id where r.project_id = $1 and r.status = 'SUCCEEDED' and r.output_asset_id is not null and m.status = 'PERSISTED' order by m.revision desc, r.finished_at desc nulls last, r.id desc limit 1", [projectId]);
    const row = result.rows[0];
    return row ? { renderId: String(row.id), outputAssetId: String(row.output_asset_id) } : null;
  }
}
