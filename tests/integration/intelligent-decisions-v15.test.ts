import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../packages/database/src/client.js';
import { buildApi } from '../../apps/api/src/app.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { IntelligentDecisionService } from '../../packages/modules/intelligence/src/index.js';

const databaseUrl = process.env.CONTENTOS_TEST_DATABASE_URL || process.env.DATABASE_URL;

test('decision evidence records a shot replacement and RecommendationBuilder uses it', { skip: !databaseUrl }, async () => {
  const db = await createDatabase(databaseUrl!); const suffix = randomUUID();
  try {
    const project = await new ProjectService(db).create(`Decision isolated ${suffix}`); const planId = `decision-plan-${suffix}`; const candidateA = `candidate-a-${suffix}`; const candidateB = `candidate-b-${suffix}`;
    const manifest = { schemaVersion: 'EDIT_MANIFEST_V0', projectId: project.id, seed: 1, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline: [{ assetId: `asset-${suffix}`, sourcePath: 'missing.mp4', sourceInMs: 0, sourceOutMs: 1_000, durationMs: 1_000, transition: 'cut' }], audio: { volume: 1 }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } };
    await db.query('insert into intelligent_edit_plans (id,project_id,status,config,source_analysis_run_ids,manifest,quality) values ($1,$2,$3,$4,$5,$6,$7)', [planId, project.id, 'READY', { schemaVersion: 'INTELLIGENT_PLANNER_CONFIG_V1', version: 'test', targetDurationMs: 1000, minClipDurationMs: 1000, maxClipDurationMs: 1000, maxAssetReuse: 1, diversityWeight: .8 }, [], manifest, { coverage: 1, repeatedAssetRatio: .9, issues: ['HIGH_ASSET_REPETITION'] }]);
    const assetId = `asset-${suffix}`; await db.query('insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [assetId, project.id, 'VIDEO', `sha256:${suffix}`, 100, `objects/${suffix}.mp4`, 'READY', {}]);
    await db.query('insert into intelligent_edit_candidates (id,plan_id,sentence_id,asset_id,score,selected,reasons,features) values ($1,$2,$3,$4,$5,$6,$7,$8),($9,$2,$3,$4,$10,$11,$12,$13)', [candidateA, planId, 's1', assetId, .8, true, JSON.stringify(['semantic']), JSON.stringify({ semantic: .8, duration: 1, quality: .5, diversity: 1, repetition: 1 }), candidateB, .7, false, JSON.stringify(['alternative']), JSON.stringify({ semantic: .7, duration: 1, quality: .5, diversity: 1, repetition: 1 })]);
    const decisions = new IntelligentDecisionService(db); const event = await decisions.createDecisionEvent({ projectId: project.id, planId, sentenceId: 's1', eventType: 'SHOT_REPLACED', previousCandidateId: candidateA, nextCandidateId: candidateB, evidence: { reason: 'manual alternative selection' } }); assert.equal(event.eventType, 'SHOT_REPLACED'); const recommendation = await decisions.buildRecommendation(project.id, planId); assert.equal(recommendation.profile, 'DIVERSITY_FIRST'); assert.ok(recommendation.evidence.decisionEventCount === 1); assert.ok((await decisions.listDecisionEvents(project.id, planId)).length === 1);
    const app = await buildApi(db); const spoofed = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/intelligence/plans/${planId}/decisions`, payload: { sentenceId: 's1', eventType: 'SHOT_REPLACED', previousCandidateId: candidateA, nextCandidateId: candidateB, previousShotId: 'forged-previous', nextShotId: 'forged-next' } }); assert.equal(spoofed.statusCode, 422); await app.close();
  } finally { await db.end(); }
});
