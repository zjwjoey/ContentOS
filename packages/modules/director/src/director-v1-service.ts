import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  validateContentBriefV1, validateScriptRevisionV1, validateStoryboardRevisionV1,
  type ContentBriefV1, type ScriptRevisionV1, type StoryboardRevisionV1,
} from '../../../contracts/src/index.js';

export type CreateBriefInput = Omit<ContentBriefV1, 'schemaVersion' | 'id' | 'projectId' | 'revision' | 'createdAt' | 'updatedAt'>;
export type CreateScriptRevisionInput = Omit<ScriptRevisionV1, 'schemaVersion' | 'id' | 'projectId' | 'briefId' | 'revision' | 'status' | 'createdAt'> & { parentRevisionId?: string };
export type CreateStoryboardRevisionInput = Omit<StoryboardRevisionV1, 'schemaVersion' | 'id' | 'projectId' | 'revision' | 'status' | 'createdAt'>;
export interface DirectorCurrentPair { brief: ContentBriefV1 | null; script: ScriptRevisionV1 | null; storyboard: StoryboardRevisionV1 | null; }
export interface DirectorProjectSummary {
  source: 'V1';
  hasRevision: boolean;
  readyForVideo: boolean;
  activeScript: { aggregateId: string; revisionId: string } | null;
  activeStoryboard: { aggregateId: string; revisionId: string } | null;
  legacyRevisionId: null;
}
export interface DirectorCurrentVideoInput {
  brief: ContentBriefV1 | null;
  script: ScriptRevisionV1 | null;
  storyboard: StoryboardRevisionV1 | null;
}

function iso(value: unknown): string { return new Date(String(value)).toISOString(); }
function json<T>(value: unknown, fallback: T): T { return (value ?? fallback) as T; }
function optionalText(value: unknown): string | undefined { return value === null || value === undefined ? undefined : String(value); }

function mapBrief(row: Record<string, unknown>): ContentBriefV1 {
  const ctaGoal = optionalText(row.cta_goal);
  return { schemaVersion: 'CONTENT_BRIEF_V1', id: String(row.id), projectId: String(row.project_id), revision: Number(row.revision), topic: String(row.topic), targetPlatform: String(row.target_platform), channelPositioning: String(row.channel_positioning), targetDurationSeconds: Number(row.target_duration_seconds), contentType: String(row.content_type), audience: String(row.audience), coreThesis: String(row.core_thesis), tone: String(row.tone), ...(ctaGoal === undefined ? {} : { ctaGoal }), referenceMaterial: String(row.reference_material), mustInclude: json<string[]>(row.must_include, []), mustAvoid: json<string[]>(row.must_avoid, []), requirements: json<Record<string, unknown>>(row.requirements, {}), createdBy: String(row.created_by), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function mapScript(row: Record<string, unknown>): ScriptRevisionV1 {
  const parentRevisionId = optionalText(row.parent_revision_id); const cta = optionalText(row.cta); const sourceJobId = optionalText(row.source_job_id); const aiRunId = optionalText(row.ai_run_id); const promptVersionId = optionalText(row.prompt_version_id);
  return { schemaVersion: 'SCRIPT_REVISION_V1', id: String(row.id), projectId: String(row.project_id), briefId: String(row.brief_id), revision: Number(row.revision), ...(parentRevisionId === undefined ? {} : { parentRevisionId }), origin: row.origin as ScriptRevisionV1['origin'], status: row.status as ScriptRevisionV1['status'], title: String(row.title), titleCandidates: json<string[]>(row.title_candidates, []), coverText: String(row.cover_text), topicKeywords: json<string[]>(row.topic_keywords, []), hook: String(row.hook), body: String(row.body), ...(cta === undefined ? {} : { cta }), ...(sourceJobId === undefined ? {} : { sourceJobId }), ...(aiRunId === undefined ? {} : { aiRunId }), ...(promptVersionId === undefined ? {} : { promptVersionId }), createdBy: String(row.created_by), createdAt: iso(row.created_at) };
}

function mapStoryboard(row: Record<string, unknown>): StoryboardRevisionV1 {
  const sourceJobId = optionalText(row.source_job_id); const aiRunId = optionalText(row.ai_run_id); const promptVersionId = optionalText(row.prompt_version_id);
  return { schemaVersion: 'STORYBOARD_REVISION_V1', id: String(row.id), projectId: String(row.project_id), scriptRevisionId: String(row.script_revision_id), revision: Number(row.revision), origin: row.origin as StoryboardRevisionV1['origin'], status: row.status as StoryboardRevisionV1['status'], scenes: json<StoryboardRevisionV1['scenes']>(row.scenes, []), ...(sourceJobId === undefined ? {} : { sourceJobId }), ...(aiRunId === undefined ? {} : { aiRunId }), ...(promptVersionId === undefined ? {} : { promptVersionId }), createdBy: String(row.created_by), createdAt: iso(row.created_at) };
}

export class DirectorV1Service {
  constructor(private readonly db: Pool) {}

  private async ensureState(client: PoolClient, projectId: string): Promise<void> {
    const project = await client.query('select 1 from content_projects where id = $1', [projectId]);
    if (!project.rowCount) throw new Error(`Project ${projectId} not found`);
    await client.query('insert into director_project_state (project_id) values ($1) on conflict (project_id) do nothing', [projectId]);
    await client.query('select project_id from director_project_state where project_id = $1 for update', [projectId]);
  }

  private async transaction<T>(projectId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try { await client.query('begin'); await this.ensureState(client, projectId); const result = await action(client); await client.query('commit'); return result; }
    catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async createBrief(projectId: string, input: CreateBriefInput): Promise<ContentBriefV1> {
    return this.transaction(projectId, async (client) => {
      const state = await client.query<{ next_brief_revision: number }>('select next_brief_revision from director_project_state where project_id = $1 for update', [projectId]);
      const revision = Number(state.rows[0]?.next_brief_revision ?? 1); const id = `brief-${randomUUID()}`; const now = new Date().toISOString();
      const brief: ContentBriefV1 = { schemaVersion: 'CONTENT_BRIEF_V1', id, projectId, revision, ...input, createdAt: now, updatedAt: now };
      validateContentBriefV1(brief);
      await client.query('insert into director_briefs (id, project_id, revision, schema_version, topic, target_platform, channel_positioning, target_duration_seconds, content_type, audience, core_thesis, tone, cta_goal, reference_material, must_include, must_avoid, requirements, created_by, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)', [id, projectId, revision, brief.schemaVersion, brief.topic, brief.targetPlatform, brief.channelPositioning, brief.targetDurationSeconds, brief.contentType, brief.audience, brief.coreThesis, brief.tone, brief.ctaGoal ?? null, brief.referenceMaterial, JSON.stringify(brief.mustInclude), JSON.stringify(brief.mustAvoid), JSON.stringify(brief.requirements), brief.createdBy, brief.createdAt, brief.updatedAt]);
      await client.query('update director_project_state set next_brief_revision = $2, active_brief_id = $3, active_script_aggregate_id = null, active_script_revision_id = null, active_storyboard_aggregate_id = null, active_storyboard_revision_id = null, updated_at = now() where project_id = $1', [projectId, revision + 1, id]);
      return brief;
    });
  }

  async createScript(projectId: string, briefId: string): Promise<{ id: string; projectId: string; briefId: string }> {
    return this.transaction(projectId, async (client) => {
      const brief = await client.query('select 1 from director_briefs where id = $1 and project_id = $2', [briefId, projectId]);
      if (!brief.rowCount) throw new Error('Brief not found for project');
      const id = `script-${randomUUID()}`;
      await client.query('insert into director_scripts (id, project_id, brief_id) values ($1, $2, $3)', [id, projectId, briefId]);
      return { id, projectId, briefId };
    });
  }

  async createScriptRevision(projectId: string, aggregateId: string, input: CreateScriptRevisionInput): Promise<ScriptRevisionV1> {
    return this.transaction(projectId, async (client) => {
      const aggregate = await client.query<{ brief_id: string }>('select brief_id from director_scripts where id = $1 and project_id = $2', [aggregateId, projectId]);
      const briefId = aggregate.rows[0]?.brief_id; if (!briefId) throw new Error('Script aggregate not found for project');
      if (input.sourceJobId) {
        const existing = await client.query('select * from director_script_revisions where source_job_id = $1 and project_id = $2', [input.sourceJobId, projectId]);
        if (existing.rows[0]) return mapScript(existing.rows[0] as Record<string, unknown>);
      }
      const state = await client.query<{ next_script_revision: number }>('select next_script_revision from director_project_state where project_id = $1 for update', [projectId]);
      const revision = Number(state.rows[0]?.next_script_revision ?? 1); const id = `script-revision-${randomUUID()}`; const createdAt = new Date().toISOString();
      const script: ScriptRevisionV1 = { schemaVersion: 'SCRIPT_REVISION_V1', id, projectId, briefId, revision, origin: input.origin, status: 'DRAFT', title: input.title, titleCandidates: input.titleCandidates, coverText: input.coverText, topicKeywords: input.topicKeywords, hook: input.hook, body: input.body, ...(input.cta === undefined ? {} : { cta: input.cta }), ...(input.parentRevisionId === undefined ? {} : { parentRevisionId: input.parentRevisionId }), ...(input.sourceJobId === undefined ? {} : { sourceJobId: input.sourceJobId }), ...(input.aiRunId === undefined ? {} : { aiRunId: input.aiRunId }), ...(input.promptVersionId === undefined ? {} : { promptVersionId: input.promptVersionId }), createdBy: input.createdBy, createdAt };
      validateScriptRevisionV1(script);
      await client.query('insert into director_script_revisions (id, aggregate_id, project_id, brief_id, revision, schema_version, parent_revision_id, origin, status, title, title_candidates, cover_text, topic_keywords, hook, body, cta, source_job_id, ai_run_id, prompt_version_id, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)', [id, aggregateId, projectId, briefId, revision, script.schemaVersion, script.parentRevisionId ?? null, script.origin, script.status, script.title, JSON.stringify(script.titleCandidates), script.coverText, JSON.stringify(script.topicKeywords), script.hook, script.body, script.cta ?? null, script.sourceJobId ?? null, script.aiRunId ?? null, script.promptVersionId ?? null, script.createdBy, createdAt]);
      await client.query('update director_project_state set next_script_revision = $2, updated_at = now() where project_id = $1', [projectId, revision + 1]);
      return script;
    });
  }

  async createManualScriptRevision(projectId: string, parentRevisionId: string, input: CreateScriptRevisionInput, createdBy: string): Promise<ScriptRevisionV1> {
    const parent = await this.getScriptRevision(parentRevisionId, projectId); if (!parent) throw new Error('Parent Script revision not found');
    return this.createScriptRevision(projectId, await this.aggregateIdForScript(parentRevisionId), { ...input, origin: 'MANUAL', parentRevisionId, createdBy });
  }

  private async aggregateIdForScript(scriptRevisionId: string): Promise<string> {
    const result = await this.db.query<{ aggregate_id: string }>('select aggregate_id from director_script_revisions where id = $1', [scriptRevisionId]);
    if (!result.rows[0]) throw new Error('Script revision not found'); return result.rows[0].aggregate_id;
  }

  async acceptScript(projectId: string, revisionId: string): Promise<ScriptRevisionV1> {
    return this.transaction(projectId, async (client) => {
      const result = await client.query('select * from director_script_revisions where id = $1 and project_id = $2 for update', [revisionId, projectId]);
      const row = result.rows[0] as Record<string, unknown> | undefined; if (!row) throw new Error('Script revision not found'); if (row.status !== 'DRAFT') throw new Error('Script revision must be DRAFT');
      await client.query("update director_script_revisions set status = 'SUPERSEDED' where project_id = $1 and status = 'ACCEPTED'", [projectId]);
      const updated = await client.query("update director_script_revisions set status = 'ACCEPTED' where id = $1 returning *", [revisionId]);
      const aggregateId = String(row.aggregate_id);
      await client.query('update director_project_state set active_script_aggregate_id = $2, active_script_revision_id = $3, active_storyboard_aggregate_id = null, active_storyboard_revision_id = null, updated_at = now() where project_id = $1', [projectId, aggregateId, revisionId]);
      return mapScript(updated.rows[0] as Record<string, unknown>);
    });
  }

  async createStoryboard(projectId: string): Promise<{ id: string; projectId: string }> {
    return this.transaction(projectId, async (client) => { const id = `storyboard-${randomUUID()}`; await client.query('insert into director_storyboards (id, project_id) values ($1, $2)', [id, projectId]); return { id, projectId }; });
  }

  async createStoryboardRevision(projectId: string, aggregateId: string, input: CreateStoryboardRevisionInput): Promise<StoryboardRevisionV1> {
    return this.transaction(projectId, async (client) => {
      const aggregate = await client.query('select 1 from director_storyboards where id = $1 and project_id = $2', [aggregateId, projectId]); if (!aggregate.rowCount) throw new Error('Storyboard aggregate not found for project');
      const script = await client.query<{ status: string }>('select status from director_script_revisions where id = $1 and project_id = $2', [input.scriptRevisionId, projectId]); if (script.rows[0]?.status !== 'ACCEPTED') throw new Error('Storyboard requires an accepted source Script');
      if (input.sourceJobId) { const existing = await client.query('select * from director_storyboard_revisions where source_job_id = $1 and project_id = $2', [input.sourceJobId, projectId]); if (existing.rows[0]) return mapStoryboard(existing.rows[0] as Record<string, unknown>); }
      const state = await client.query<{ next_storyboard_revision: number }>('select next_storyboard_revision from director_project_state where project_id = $1 for update', [projectId]); const revision = Number(state.rows[0]?.next_storyboard_revision ?? 1); const id = `storyboard-revision-${randomUUID()}`; const createdAt = new Date().toISOString();
      const storyboard: StoryboardRevisionV1 = { schemaVersion: 'STORYBOARD_REVISION_V1', id, projectId, scriptRevisionId: input.scriptRevisionId, revision, origin: input.origin, status: 'DRAFT', scenes: input.scenes, ...(input.sourceJobId === undefined ? {} : { sourceJobId: input.sourceJobId }), ...(input.aiRunId === undefined ? {} : { aiRunId: input.aiRunId }), ...(input.promptVersionId === undefined ? {} : { promptVersionId: input.promptVersionId }), createdBy: input.createdBy, createdAt };
      validateStoryboardRevisionV1(storyboard);
      await client.query('insert into director_storyboard_revisions (id, aggregate_id, project_id, script_revision_id, revision, schema_version, origin, status, scenes, source_job_id, ai_run_id, prompt_version_id, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)', [id, aggregateId, projectId, storyboard.scriptRevisionId, revision, storyboard.schemaVersion, storyboard.origin, storyboard.status, JSON.stringify(storyboard.scenes), storyboard.sourceJobId ?? null, storyboard.aiRunId ?? null, storyboard.promptVersionId ?? null, storyboard.createdBy, createdAt]);
      await client.query('update director_project_state set next_storyboard_revision = $2, updated_at = now() where project_id = $1', [projectId, revision + 1]); return storyboard;
    });
  }

  async approveStoryboard(projectId: string, revisionId: string): Promise<StoryboardRevisionV1> {
    return this.transaction(projectId, async (client) => {
      const result = await client.query('select b.*, s.status as script_status from director_storyboard_revisions b join director_script_revisions s on s.id = b.script_revision_id where b.id = $1 and b.project_id = $2 for update', [revisionId, projectId]); const row = result.rows[0] as (Record<string, unknown> & { script_status: string }) | undefined; if (!row) throw new Error('Storyboard revision not found'); if (row.status !== 'DRAFT') throw new Error('Storyboard revision must be DRAFT'); if (row.script_status !== 'ACCEPTED') throw new Error('Storyboard requires an accepted source Script');
      const state = await client.query<{ active_script_revision_id: string | null }>('select active_script_revision_id from director_project_state where project_id = $1 for update', [projectId]); if (state.rows[0]?.active_script_revision_id !== String(row.script_revision_id)) throw new Error('Storyboard source Script is not the active Script');
      await client.query("update director_storyboard_revisions set status = 'SUPERSEDED' where project_id = $1 and status = 'APPROVED'", [projectId]); const updated = await client.query("update director_storyboard_revisions set status = 'APPROVED' where id = $1 returning *", [revisionId]);
      await client.query('update director_project_state set active_storyboard_aggregate_id = $2, active_storyboard_revision_id = $3, updated_at = now() where project_id = $1', [projectId, String(row.aggregate_id), revisionId]); return mapStoryboard(updated.rows[0] as Record<string, unknown>);
    });
  }

  async getBrief(id: string, projectId: string): Promise<ContentBriefV1 | null> { const result = await this.db.query('select * from director_briefs where id = $1 and project_id = $2', [id, projectId]); return result.rows[0] ? mapBrief(result.rows[0] as Record<string, unknown>) : null; }
  async getScriptRevision(id: string, projectId: string): Promise<ScriptRevisionV1 | null> { const result = await this.db.query('select * from director_script_revisions where id = $1 and project_id = $2', [id, projectId]); return result.rows[0] ? mapScript(result.rows[0] as Record<string, unknown>) : null; }
  async listScriptRevisions(projectId: string): Promise<ScriptRevisionV1[]> { const result = await this.db.query('select * from director_script_revisions where project_id = $1 order by revision', [projectId]); return result.rows.map((row) => mapScript(row as Record<string, unknown>)); }
  async getStoryboardRevision(id: string, projectId: string): Promise<StoryboardRevisionV1 | null> { const result = await this.db.query('select * from director_storyboard_revisions where id = $1 and project_id = $2', [id, projectId]); return result.rows[0] ? mapStoryboard(result.rows[0] as Record<string, unknown>) : null; }
  async listStoryboardRevisions(projectId: string): Promise<StoryboardRevisionV1[]> { const result = await this.db.query('select * from director_storyboard_revisions where project_id = $1 order by revision', [projectId]); return result.rows.map((row) => mapStoryboard(row as Record<string, unknown>)); }

  async getCurrentPair(projectId: string): Promise<DirectorCurrentPair> {
    return (await this.getCurrentVideoInput(projectId)) || { brief: null, script: null, storyboard: null };
  }

  async getCurrentVideoInput(projectId: string): Promise<DirectorCurrentVideoInput | null> {
    const result = await this.db.query<{ brief: Record<string, unknown> | null; script: Record<string, unknown> | null; storyboard: Record<string, unknown> | null }>('select to_jsonb(b) as brief, to_jsonb(sr) as script, to_jsonb(sb) as storyboard from director_project_state s left join director_briefs b on b.id = s.active_brief_id and b.project_id = s.project_id left join director_script_revisions sr on sr.id = s.active_script_revision_id and sr.project_id = s.project_id left join director_storyboard_revisions sb on sb.id = s.active_storyboard_revision_id and sb.project_id = s.project_id where s.project_id = $1', [projectId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      brief: row.brief ? mapBrief(row.brief) : null,
      script: row.script ? mapScript(row.script) : null,
      storyboard: row.storyboard ? mapStoryboard(row.storyboard) : null,
    };
  }

  async getProjectSummary(projectId: string): Promise<DirectorProjectSummary | null> {
    const state = await this.db.query<{ active_script_aggregate_id: string | null; active_script_revision_id: string | null; active_storyboard_aggregate_id: string | null; active_storyboard_revision_id: string | null; brief_id: string | null; script_id: string | null; script_status: string | null; storyboard_id: string | null; storyboard_status: string | null }>('select s.active_script_aggregate_id, s.active_script_revision_id, s.active_storyboard_aggregate_id, s.active_storyboard_revision_id, b.id as brief_id, sr.id as script_id, sr.status as script_status, sb.id as storyboard_id, sb.status as storyboard_status from director_project_state s left join director_briefs b on b.id = s.active_brief_id and b.project_id = s.project_id left join director_script_revisions sr on sr.id = s.active_script_revision_id and sr.project_id = s.project_id left join director_storyboard_revisions sb on sb.id = s.active_storyboard_revision_id and sb.project_id = s.project_id where s.project_id = $1', [projectId]);
    const current = state.rows[0];
    if (!current) return null;
    return {
      source: 'V1',
      hasRevision: Boolean(current.brief_id || current.script_id || current.storyboard_id),
      readyForVideo: current.script_status === 'ACCEPTED' && current.storyboard_status === 'APPROVED',
      activeScript: current.active_script_aggregate_id && current.active_script_revision_id && current.script_id ? { aggregateId: current.active_script_aggregate_id, revisionId: current.active_script_revision_id } : null,
      activeStoryboard: current.active_storyboard_aggregate_id && current.active_storyboard_revision_id && current.storyboard_id ? { aggregateId: current.active_storyboard_aggregate_id, revisionId: current.active_storyboard_revision_id } : null,
      legacyRevisionId: null,
    };
  }
}
