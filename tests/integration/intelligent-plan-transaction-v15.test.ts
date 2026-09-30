import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createDatabase } from '../../packages/database/src/client.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { VideoService } from '../../packages/modules/video/src/index.js';
import { IntelligentPlanningService } from '../../packages/modules/intelligence/src/index.js';

const databaseUrl = process.env.CONTENTOS_TEST_DATABASE_URL || process.env.DATABASE_URL;

type Fixture = { db: Pool; projectId: string; assetId: string; planId: string; planning: IntelligentPlanningService; video: VideoService };

const plannerConfig = { schemaVersion: 'INTELLIGENT_PLANNER_CONFIG_V1', version: 'transaction-plan-v15-test', targetDurationMs: 1_000, minClipDurationMs: 1_000, maxClipDurationMs: 1_000, maxAssetReuse: 1, diversityWeight: 0.8 } as const;

async function fixture(dbOverride?: Pool): Promise<Fixture> {
  const db = dbOverride || await createDatabase(databaseUrl!);
  const suffix = randomUUID();
  const project = await new ProjectService(db).create(`Atomic intelligent plan ${suffix}`);
  const assetId = `atomic-plan-asset-${suffix}`;
  const runId = `atomic-plan-run-${suffix}`;
  const shotIds = [0, 1, 2].map((index) => `atomic-plan-shot-${suffix}-${index}`);
  await db.query('insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [assetId, project.id, 'VIDEO', `sha256:${assetId}`, 100, `sources/${assetId}.mp4`, 'READY', { durationMs: 3_000, width: 640, height: 360 }]);
  await db.query('insert into project_assets(project_id,asset_id,role) values ($1,$2,$3)', [project.id, assetId, 'SOURCE']);
  await db.query('insert into media_analysis_runs (id,project_id,asset_id,status,capabilities,provider_mode,analysis_version,idempotency_key,source_checksum) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [runId, project.id, assetId, 'SUCCEEDED', ['SHOTS'], 'FAKE', 'transaction-plan-v15', `atomic-plan:${assetId}`, `sha256:${assetId}`]);
  for (const [shotIndex, shotId] of shotIds.entries()) await db.query('insert into media_analysis_shots (id,run_id,asset_id,shot_index,source_in_ms,source_out_ms,confidence,detection_version) values ($1,$2,$3,$4,$5,$6,$7,$8)', [shotId, runId, assetId, shotIndex, 0, 3_000, 0.9 - shotIndex * 0.1, 'transaction-test']);
  const planId = `atomic-plan-${suffix}`;
  const jobs = new JobService(db);
  const video = new VideoService(db, jobs);
  return { db, projectId: project.id, assetId, planId, planning: new IntelligentPlanningService(db, { video }), video };
}

async function persistenceCounts(db: Pool, projectId: string): Promise<{ manifests: number; jobs: number; plans: number; candidates: number; evaluations: number }> {
  const result = await db.query<{ manifests: string; jobs: string; plans: string; candidates: string; evaluations: string }>(`select
    (select count(*) from edit_manifests where project_id=$1) as manifests,
    (select count(*) from jobs where project_id=$1 and type='VIDEO_RENDER') as jobs,
    (select count(*) from intelligent_edit_plans where project_id=$1) as plans,
    (select count(*) from intelligent_edit_candidates c join intelligent_edit_plans p on p.id=c.plan_id where p.project_id=$1) as candidates,
    (select count(*) from intelligent_edit_evaluations e join intelligent_edit_plans p on p.id=e.plan_id where p.project_id=$1) as evaluations`, [projectId]);
  const row = result.rows[0]!;
  return { manifests: Number(row.manifests), jobs: Number(row.jobs), plans: Number(row.plans), candidates: Number(row.candidates), evaluations: Number(row.evaluations) };
}

async function createPlan(state: Fixture): Promise<void> {
  await state.planning.createPlan({ id: state.planId, projectId: state.projectId, assetIds: [state.assetId], sentences: [{ id: 's1', text: 'atomic plan sentence', durationMs: 1_000 }], config: plannerConfig });
}

function instrumentDatabase(real: Pool, shouldFail: (statement: string, count: number) => boolean): Pool {
  const wrapped = {
    query: real.query.bind(real),
    connect: async () => {
      const client = await real.connect();
      const originalQuery = client.query.bind(client);
      let count = 0;
      const query = ((...args: unknown[]) => {
        const statement = typeof args[0] === 'string' ? args[0] : '';
        count += 1;
        if (shouldFail(statement, count)) return Reflect.apply(originalQuery, client, ['select * from create_plan_fault_injection_missing_table']);
        return Reflect.apply(originalQuery, client, args as never[]);
      }) as typeof client.query;
      return new Proxy(client, { get(target, property, receiver) {
        if (property === 'query') return query;
        if (property === 'release') return target.release.bind(target);
        return Reflect.get(target, property, receiver);
      } });
    },
  } as unknown as Pool;
  return wrapped;
}

async function assertPlanPersistenceRolledBack(state: Fixture, run: () => Promise<unknown>): Promise<void> {
  const before = await persistenceCounts(state.db, state.projectId);
  await assert.rejects(run);
  assert.deepEqual(await persistenceCounts(state.db, state.projectId), before);
}

test('createPlan persists Manifest, Job, Plan, Candidates and Evaluation atomically on success', { skip: !databaseUrl }, async () => {
  const state = await fixture();
  try {
    const result = await state.planning.createPlan({ id: state.planId, projectId: state.projectId, assetIds: [state.assetId], sentences: [{ id: 's1', text: 'atomic plan sentence', durationMs: 1_000 }], config: plannerConfig });
    const counts = await persistenceCounts(state.db, state.projectId);
    assert.equal(counts.manifests, 1); assert.equal(counts.jobs, 1); assert.equal(counts.plans, 1); assert.equal(counts.candidates, result.candidates.length); assert.equal(counts.evaluations, 1);
    const stored = (await state.db.query<{ manifest_id: string; render_job_id: string }>('select manifest_id,render_job_id from intelligent_edit_plans where id=$1', [state.planId])).rows[0];
    assert.equal(stored?.manifest_id, result.manifestId); assert.equal(stored?.render_job_id, result.renderJobId);
  } finally { await state.db.end(); }
});

test('createPlan rolls back after Manifest persistence failure', { skip: !databaseUrl }, async () => {
  const base = await fixture();
  try {
    const db = instrumentDatabase(base.db, (statement) => statement.includes('insert into edit_manifests'));
    const state = { ...base, planning: new IntelligentPlanningService(db, { video: new VideoService(db, new JobService(base.db)) }) };
    await assertPlanPersistenceRolledBack(state, () => createPlan(state));
  } finally { await base.db.end(); }
});

test('createPlan rolls back after Render Job persistence failure', { skip: !databaseUrl }, async () => {
  const base = await fixture();
  try {
    const db = instrumentDatabase(base.db, (statement) => statement.includes('insert into jobs'));
    const state = { ...base, planning: new IntelligentPlanningService(db, { video: new VideoService(db, new JobService(base.db)) }) };
    await assertPlanPersistenceRolledBack(state, () => createPlan(state));
  } finally { await base.db.end(); }
});

test('createPlan rolls back after Plan persistence failure', { skip: !databaseUrl }, async () => {
  const base = await fixture();
  try {
    const db = instrumentDatabase(base.db, (statement) => statement.includes('insert into intelligent_edit_plans'));
    const state = { ...base, planning: new IntelligentPlanningService(db, { video: new VideoService(db, new JobService(base.db)) }) };
    await assertPlanPersistenceRolledBack(state, () => createPlan(state));
  } finally { await base.db.end(); }
});

test('createPlan rolls back a partial Candidate batch', { skip: !databaseUrl }, async () => {
  const base = await fixture();
  try {
    let candidateInserts = 0;
    const db = instrumentDatabase(base.db, (statement) => { if (statement.includes('insert into intelligent_edit_candidates')) { candidateInserts += 1; return candidateInserts === 2; } return false; });
    const state = { ...base, planning: new IntelligentPlanningService(db, { video: new VideoService(db, new JobService(base.db)) }) };
    await assertPlanPersistenceRolledBack(state, () => createPlan(state));
  } finally { await base.db.end(); }
});

test('createPlan rolls back when Evaluation persistence fails', { skip: !databaseUrl }, async () => {
  const base = await fixture();
  try {
    const db = instrumentDatabase(base.db, (statement) => statement.includes('insert into intelligent_edit_evaluations'));
    const state = { ...base, planning: new IntelligentPlanningService(db, { video: new VideoService(db, new JobService(base.db)) }) };
    await assertPlanPersistenceRolledBack(state, () => createPlan(state));
  } finally { await base.db.end(); }
});
