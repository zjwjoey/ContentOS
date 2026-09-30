import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createDatabase } from '../../packages/database/src/client.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { VideoService } from '../../packages/modules/video/src/index.js';
import { IntelligentPlanningService } from '../../packages/modules/intelligence/src/index.js';
import type { EditManifestV0 } from '../../packages/contracts/src/index.js';

const databaseUrl = process.env.CONTENTOS_TEST_DATABASE_URL || process.env.DATABASE_URL;

type Fixture = {
  db: Pool;
  planning: IntelligentPlanningService;
  video: VideoService;
  projectId: string;
  planId: string;
  candidateIds: { initial: string; alternative: string; concurrent: string };
};

const config = {
  schemaVersion: 'INTELLIGENT_PLANNER_CONFIG_V1',
  version: 'transaction-v15-test',
  targetDurationMs: 1_000,
  minClipDurationMs: 1_000,
  maxClipDurationMs: 1_000,
  maxAssetReuse: 1,
  diversityWeight: 0.8,
};

function manifest(projectId: string, planId: string, assetId: string): EditManifestV0 {
  return {
    schemaVersion: 'EDIT_MANIFEST_V0', projectId, seed: 1,
    canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 },
    timeline: [{ assetId, sourcePath: `sources/${assetId}.mp4`, sourceInMs: 0, sourceOutMs: 1_000, durationMs: 1_000, transition: 'cut', sentenceIndex: 0, sentenceId: 's1', sentenceText: 'replacement test', matching: { matchedKeywords: [], matchScore: 1, fallback: false, matchingReason: 'transaction test', shotType: 'medium' }, selectionSource: 'AUTO', revision: 1 }],
    audio: { volume: 1 },
    metadata: { intelligentPlanId: planId, sentences: [{ index: 0, text: 'replacement test', normalizedText: 'replacement test', durationMs: 1_000 }] },
    output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' },
  };
}

async function fixture(): Promise<Fixture> {
  const db = await createDatabase(databaseUrl!);
  const suffix = randomUUID();
  const project = await new ProjectService(db).create(`Transactional replacement ${suffix}`);
  const assetIds = { initial: `tx-initial-${suffix}`, alternative: `tx-alternative-${suffix}`, concurrent: `tx-concurrent-${suffix}` };
  for (const assetId of Object.values(assetIds)) {
    await db.query('insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [assetId, project.id, 'VIDEO', `sha256:${assetId}`, 100, `sources/${assetId}.mp4`, 'READY', { durationMs: 4_000, width: 640, height: 360 }]);
    await db.query('insert into project_assets(project_id,asset_id,role) values ($1,$2,$3)', [project.id, assetId, 'SOURCE']);
  }
  const planId = `intelligent-plan-${suffix}`;
  const jobs = new JobService(db);
  const video = new VideoService(db, jobs);
  const initial = await video.createManifestRevision(project.id, manifest(project.id, planId, assetIds.initial), { createdBy: 'transaction-test', idempotencyKey: `transaction-test:${planId}:initial` });
  const initialJob = await video.createManifestRenderJob(project.id, initial.manifestId);
  await db.query('insert into intelligent_edit_plans (id,project_id,status,config,source_analysis_run_ids,manifest,quality,manifest_id,video_revision_id,render_job_id,planner_version,analysis_version,revision) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [planId, project.id, 'READY', config, [], manifest(project.id, planId, assetIds.initial), { semanticMatch: 1, diversity: 0, repetition: 0, durationFit: 1, technical: 1, overall: 1, issues: [] }, initial.manifestId, initial.manifestId, initialJob.id, 'transaction-test', 'transaction-test', 1]);
  const candidateIds = { initial: `candidate-initial-${suffix}`, alternative: `candidate-alternative-${suffix}`, concurrent: `candidate-concurrent-${suffix}` };
  for (const [candidateId, assetId, score, selected] of [[candidateIds.initial, assetIds.initial, 1, true], [candidateIds.alternative, assetIds.alternative, 0.9, false], [candidateIds.concurrent, assetIds.concurrent, 0.8, false]] as const) {
    await db.query('insert into intelligent_edit_candidates (id,plan_id,sentence_id,asset_id,shot_id,source_in_ms,source_out_ms,score,selected,reasons,features) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [candidateId, planId, 's1', assetId, null, 0, 1_000, score, selected, [], {}]);
  }
  return { db, planning: new IntelligentPlanningService(db, { video }), video, projectId: project.id, planId, candidateIds };
}

async function snapshot(db: Pool, planId: string): Promise<{ revision: number; selected: string[]; manifests: number; renderJobs: number; decisions: number }> {
  const plan = (await db.query<{ revision: number }>('select revision from intelligent_edit_plans where id=$1', [planId])).rows[0];
  const selected = await db.query<{ id: string }>('select id from intelligent_edit_candidates where plan_id=$1 and selected=true order by id', [planId]);
  const manifests = await db.query<{ count: string }>('select count(*)::text as count from edit_manifests where project_id=(select project_id from intelligent_edit_plans where id=$1)', [planId]);
  const renderJobs = await db.query<{ count: string }>("select count(*)::text as count from jobs where project_id=(select project_id from intelligent_edit_plans where id=$1) and type='VIDEO_RENDER'", [planId]);
  const decisions = await db.query<{ count: string }>('select count(*)::text as count from editing_decision_events where plan_id=$1', [planId]);
  return { revision: Number(plan?.revision), selected: selected.rows.map((row) => row.id), manifests: Number(manifests.rows[0]?.count), renderJobs: Number(renderJobs.rows[0]?.count), decisions: Number(decisions.rows[0]?.count) };
}

async function assertAtomicFailure(run: () => Promise<unknown>, db: Pool, planId: string, before: Awaited<ReturnType<typeof snapshot>>): Promise<void> {
  await assert.rejects(run);
  assert.deepEqual(await snapshot(db, planId), before);
}

test('candidate replacement rolls back manifest when the manifest stage fails after persistence', { skip: !databaseUrl }, async () => {
  const state = await fixture();
  try {
    const before = await snapshot(state.db, state.planId);
    const original = state.video.createManifestRevisionWithExecutor.bind(state.video);
    state.video.createManifestRevisionWithExecutor = async (...args: Parameters<VideoService['createManifestRevisionWithExecutor']>) => { await original(...args); throw new Error('injected after manifest'); };
    await assertAtomicFailure(() => state.planning.applyCandidateReplacement({ projectId: state.projectId, planId: state.planId, sentenceId: 's1', candidateId: state.candidateIds.alternative }), state.db, state.planId, before);
  } finally { await state.db.end(); }
});

test('candidate replacement rolls back manifest and job when the render stage fails', { skip: !databaseUrl }, async () => {
  const state = await fixture();
  try {
    const projectId = state.projectId;
    const before = await snapshot(state.db, state.planId);
    const original = state.video.createManifestRenderJobWithExecutor.bind(state.video);
    state.video.createManifestRenderJobWithExecutor = async (...args: Parameters<VideoService['createManifestRenderJobWithExecutor']>) => { await original(...args); throw new Error('injected after render job'); };
    await assertAtomicFailure(() => state.planning.applyCandidateReplacement({ projectId, planId: state.planId, sentenceId: 's1', candidateId: state.candidateIds.alternative }), state.db, state.planId, before);
  } finally { await state.db.end(); }
});

test('candidate replacement rolls back all rows when decision evidence insertion fails', { skip: !databaseUrl }, async () => {
  const state = await fixture();
  const originalConnect = state.db.connect.bind(state.db);
  try {
    const projectId = state.projectId;
    const before = await snapshot(state.db, state.planId);
    (state.db as unknown as { connect: typeof state.db.connect }).connect = async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      client.query = ((...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].includes('insert into editing_decision_events')) throw new Error('injected decision failure');
        return Reflect.apply(originalQuery, client, args as never[]);
      }) as typeof client.query;
      return client;
    };
    await assert.rejects(() => state.planning.applyCandidateReplacement({ projectId, planId: state.planId, sentenceId: 's1', candidateId: state.candidateIds.alternative }));
    (state.db as unknown as { connect: typeof state.db.connect }).connect = originalConnect;
    assert.deepEqual(await snapshot(state.db, state.planId), before);
  } finally { (state.db as unknown as { connect: typeof state.db.connect }).connect = originalConnect; await state.db.end(); }
});

test('concurrent replacements serialize and only one candidate wins', { skip: !databaseUrl }, async () => {
  const state = await fixture();
  try {
    const projectId = state.projectId;
    const results = await Promise.allSettled([
      state.planning.applyCandidateReplacement({ projectId, planId: state.planId, sentenceId: 's1', candidateId: state.candidateIds.alternative }),
      state.planning.applyCandidateReplacement({ projectId, planId: state.planId, sentenceId: 's1', candidateId: state.candidateIds.concurrent }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const after = await snapshot(state.db, state.planId);
    assert.equal(after.selected.length, 1);
    assert.equal(after.revision, 2);
    assert.equal(after.manifests, 2);
    assert.equal(after.renderJobs, 2);
    assert.equal(after.decisions, 1);
  } finally { await state.db.end(); }
});

test('duplicate replacement request returns already-selected without a second revision', { skip: !databaseUrl }, async () => {
  const state = await fixture();
  try {
    const projectId = state.projectId;
    await state.planning.applyCandidateReplacement({ projectId, planId: state.planId, sentenceId: 's1', candidateId: state.candidateIds.alternative });
    const before = await snapshot(state.db, state.planId);
    await assert.rejects(() => state.planning.applyCandidateReplacement({ projectId, planId: state.planId, sentenceId: 's1', candidateId: state.candidateIds.alternative }), /INTELLIGENT_CANDIDATE_ALREADY_SELECTED/);
    assert.deepEqual(await snapshot(state.db, state.planId), before);
  } finally { await state.db.end(); }
});

test('repeated replacements preserve history and allow A to B to C', { skip: !databaseUrl }, async () => {
  const state = await fixture();
  try {
    await state.planning.applyCandidateReplacement({ projectId: state.projectId, planId: state.planId, sentenceId: 's1', candidateId: state.candidateIds.alternative });
    const second = await state.planning.applyCandidateReplacement({ projectId: state.projectId, planId: state.planId, sentenceId: 's1', candidateId: state.candidateIds.concurrent });
    assert.equal(second.revision, 3);
    const after = await snapshot(state.db, state.planId);
    assert.deepEqual(after.selected, [state.candidateIds.concurrent]);
    assert.equal(after.revision, 3);
    assert.equal(after.manifests, 3);
    assert.equal(after.renderJobs, 3);
    assert.equal(after.decisions, 2);
    const events = await state.db.query<{ previous_candidate_id: string; next_candidate_id: string }>('select previous_candidate_id,next_candidate_id from editing_decision_events where plan_id=$1 order by created_at,id', [state.planId]);
    assert.deepEqual(events.rows, [
      { previous_candidate_id: state.candidateIds.initial, next_candidate_id: state.candidateIds.alternative },
      { previous_candidate_id: state.candidateIds.alternative, next_candidate_id: state.candidateIds.concurrent },
    ]);
  } finally { await state.db.end(); }
});
