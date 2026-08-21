import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface ProjectRecord { id: string; name: string; status: string; metadata: unknown; createdAt: string; updatedAt: string; }

function mapProject(row: Record<string, unknown>): ProjectRecord {
  return { id: String(row.id), name: String(row.name), status: String(row.status), metadata: row.metadata, createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() };
}

export class ProjectService {
  constructor(private readonly db: Pool) {}
  async create(name: string, metadata: unknown = {}): Promise<ProjectRecord> {
    const id = `project-${randomUUID()}`;
    const result = await this.db.query('insert into content_projects (id, name, status, metadata) values ($1, $2, $3, $4) returning *', [id, name, 'DRAFT', metadata]);
    return mapProject(result.rows[0] as Record<string, unknown>);
  }
  async get(id: string): Promise<ProjectRecord | null> {
    const result = await this.db.query('select * from content_projects where id = $1', [id]);
    return result.rows[0] ? mapProject(result.rows[0] as Record<string, unknown>) : null;
  }
  async list(): Promise<ProjectRecord[]> {
    const result = await this.db.query('select * from content_projects order by created_at desc');
    return result.rows.map((row) => mapProject(row as Record<string, unknown>));
  }
  async setCurrentDirectorRevision(projectId: string, revisionId: string): Promise<void> {
    const result = await this.db.query('update content_projects set current_director_revision_id = $2, updated_at = now() where id = $1', [projectId, revisionId]);
    if (!result.rowCount) throw new Error(`Project ${projectId} not found`);
  }
}
