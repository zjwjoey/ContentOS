import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface ProjectRecord { id: string; name: string; status: string; metadata: unknown; createdAt: string; updatedAt: string; }
export interface ProjectPublishingFacts { hasPublishableAsset: boolean; publishedRequestCount: number; }
export interface ProjectListFilters { query?: string; status?: string; plannedDateFrom?: string; plannedDateTo?: string; account?: string; platform?: string; }

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
  async list(filters: ProjectListFilters = {}): Promise<ProjectRecord[]> {
    const clauses = ['1=1']; const values: unknown[] = [];
    if (filters.query?.trim()) { values.push(`%${filters.query.trim()}%`); clauses.push(`(name ilike $${values.length} or coalesce(metadata->>'topic','') ilike $${values.length})`); }
    if (filters.status?.trim()) { values.push(filters.status.trim()); clauses.push(`status = $${values.length}`); }
    if (filters.plannedDateFrom?.trim()) { values.push(filters.plannedDateFrom.trim()); clauses.push(`coalesce(metadata->>'plannedDate','') >= $${values.length}`); }
    if (filters.plannedDateTo?.trim()) { values.push(filters.plannedDateTo.trim()); clauses.push(`coalesce(metadata->>'plannedDate','') <= $${values.length}`); }
    if (filters.account?.trim()) { values.push(filters.account.trim()); clauses.push(`coalesce(metadata->>'targetAccount','') = $${values.length}`); }
    if (filters.platform?.trim()) { values.push(filters.platform.trim()); clauses.push(`coalesce(metadata->>'targetPlatform','') = $${values.length}`); }
    const result = await this.db.query(`select * from content_projects where ${clauses.join(' and ')} order by created_at desc`, values);
    return result.rows.map((row) => mapProject(row as Record<string, unknown>));
  }
  async update(id: string, input: { name?: string; metadata?: Record<string, unknown>; status?: string }): Promise<ProjectRecord> {
    if (input.name !== undefined && !input.name.trim()) throw new Error('Project name must be non-empty');
    const current = await this.get(id); if (!current) throw new Error(`Project ${id} not found`);
    const metadata = input.metadata === undefined ? current.metadata : { ...(current.metadata && typeof current.metadata === 'object' ? current.metadata as Record<string, unknown> : {}), ...input.metadata };
    const result = await this.db.query('update content_projects set name = coalesce($2,name), metadata = $3, status = coalesce($4,status), updated_at = now() where id = $1 returning *', [id, input.name?.trim() || null, metadata, input.status || null]);
    return mapProject(result.rows[0] as Record<string, unknown>);
  }
  async archive(id: string): Promise<ProjectRecord> { return this.update(id, { status: 'ARCHIVED' }); }
  async setCurrentDirectorRevision(projectId: string, revisionId: string): Promise<void> {
    const result = await this.db.query('update content_projects set current_director_revision_id = $2, updated_at = now() where id = $1', [projectId, revisionId]);
    if (!result.rowCount) throw new Error(`Project ${projectId} not found`);
  }

  async syncPublishingStatus(projectId: string, facts: ProjectPublishingFacts): Promise<ProjectRecord> {
    if (!Number.isInteger(facts.publishedRequestCount) || facts.publishedRequestCount < 0) throw new Error('publishedRequestCount must be a non-negative integer');
    const updated = await this.db.query(`
      update content_projects
      set status = case
        when status in ('ARCHIVED', 'REVIEWED', 'PUBLISHED') then status
        when $2::integer > 0 then 'PUBLISHED'
        when $3::boolean and status in ('DRAFT', 'IN_PRODUCTION') then 'READY_TO_PUBLISH'
        else status
      end,
      updated_at = now()
      where id = $1
      returning *
    `, [projectId, facts.publishedRequestCount, facts.hasPublishableAsset]);
    if (!updated.rowCount) throw new Error(`Project ${projectId} not found`);
    return mapProject(updated.rows[0] as Record<string, unknown>);
  }
}
