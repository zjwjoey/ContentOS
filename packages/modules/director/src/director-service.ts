import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { validateDirectorPlan, type DirectorPlanV0 } from '../../../contracts/src/index.js';
import { ProjectService } from '../../project/src/index.js';

export type DirectorRevisionStatus = 'DRAFT' | 'ACCEPTED' | 'APPROVED' | 'SUPERSEDED';
export interface DirectorRevision { id: string; projectId: string; revision: number; plan: DirectorPlanV0; status: DirectorRevisionStatus; createdAt: string; }

function mapRevision(row: Record<string, unknown>): DirectorRevision {
  return { id: String(row.id), projectId: String(row.project_id), revision: Number(row.revision), plan: { schemaVersion: String(row.schema_version) as 'DIRECTOR_PLAN_V0', projectId: String(row.project_id), seed: Number((row.provenance as Record<string, unknown>)?.seed || 0), brief: row.brief as DirectorPlanV0['brief'], storyboard: row.storyboard as DirectorPlanV0['storyboard'], provenance: row.provenance as DirectorPlanV0['provenance'] }, status: row.status as DirectorRevisionStatus, createdAt: new Date(String(row.created_at)).toISOString() };
}

export class DirectorService {
  constructor(private readonly db: Pool, private readonly projects = new ProjectService(db)) {}

  private async assertPlan(projectId: string, plan: DirectorPlanV0): Promise<void> {
    if (plan.projectId !== projectId) throw new Error('Director plan projectId mismatch');
    validateDirectorPlan(plan);
    if (!(await this.projects.get(projectId))) throw new Error(`Project ${projectId} not found`);
  }

  async createDraft(projectId: string, plan: DirectorPlanV0): Promise<DirectorRevision> {
    await this.assertPlan(projectId, plan);
    const next = await this.db.query<{ revision: number }>('select coalesce(max(revision), 0) + 1 as revision from director_plan_revisions where project_id = $1', [projectId]);
    const revision = Number(next.rows[0]?.revision || 1);
    const id = `director-revision-${randomUUID()}`;
    const provenance = { ...plan.provenance, seed: plan.seed };
    const result = await this.db.query('insert into director_plan_revisions (id, project_id, revision, schema_version, brief, storyboard, provenance, status) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8) returning *', [id, projectId, revision, plan.schemaVersion, JSON.stringify(plan.brief), JSON.stringify(plan.storyboard), JSON.stringify(provenance), 'DRAFT']);
    return mapRevision(result.rows[0] as Record<string, unknown>);
  }

  async revise(projectId: string, baseRevision: number, plan: DirectorPlanV0): Promise<DirectorRevision> {
    const base = await this.get(projectId, baseRevision);
    if (!base) throw new Error('Base Director revision not found');
    return this.createDraft(projectId, plan);
  }

  async accept(projectId: string, revision: number): Promise<DirectorRevision> {
    return this.transition(projectId, revision, 'DRAFT', 'ACCEPTED');
  }

  async approveStoryboard(projectId: string, revision: number): Promise<DirectorRevision> {
    const accepted = await this.transition(projectId, revision, 'ACCEPTED', 'APPROVED');
    await this.projects.setCurrentDirectorRevision(projectId, accepted.id);
    return accepted;
  }

  private async transition(projectId: string, revision: number, expected: DirectorRevisionStatus, next: DirectorRevisionStatus): Promise<DirectorRevision> {
    const result = await this.db.query('update director_plan_revisions set status = $3 where project_id = $1 and revision = $2 and status = $4 returning *', [projectId, revision, next, expected]);
    if (!result.rows[0]) throw new Error(`Director revision ${revision} must be ${expected}`);
    return mapRevision(result.rows[0] as Record<string, unknown>);
  }

  async get(projectId: string, revision: number): Promise<DirectorRevision | null> {
    const result = await this.db.query('select * from director_plan_revisions where project_id = $1 and revision = $2', [projectId, revision]);
    return result.rows[0] ? mapRevision(result.rows[0] as Record<string, unknown>) : null;
  }

  async list(projectId: string): Promise<DirectorRevision[]> {
    const result = await this.db.query('select * from director_plan_revisions where project_id = $1 order by revision', [projectId]);
    return result.rows.map((row) => mapRevision(row as Record<string, unknown>));
  }

  async getCurrent(projectId: string): Promise<DirectorRevision | null> {
    const result = await this.db.query('select d.* from director_plan_revisions d join content_projects p on p.current_director_revision_id = d.id where p.id = $1', [projectId]);
    return result.rows[0] ? mapRevision(result.rows[0] as Record<string, unknown>) : null;
  }
}
