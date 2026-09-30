import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../packages/database/src/client.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { IntelligentDecisionService, IntelligentPlanningService } from '../../packages/modules/intelligence/src/index.js';

const databaseUrl = process.env.CONTENTOS_INTELLIGENCE_TEST_DATABASE_URL;

test('intelligent decisions keep preset and recommendation evidence reviewable', { skip: !databaseUrl }, async () => {
  const db = await createDatabase(databaseUrl!);
  const suffix = randomUUID();
  try {
    const project = await new ProjectService(db).create(`Decision isolated ${suffix}`);
    const assetId = `decision-asset-${suffix}`;
    await db.query('insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [assetId, project.id, 'VIDEO', `sha256:decision-${suffix}`, 100, `objects/${assetId}.mp4`, 'READY', { durationMs: 1_000 }]);
    await db.query('insert into project_assets(project_id,asset_id,role) values ($1,$2,$3)', [project.id, assetId, 'SOURCE']);
    const config = { schemaVersion: 'INTELLIGENT_PLANNER_CONFIG_V1' as const, version: 'decision-v1', targetDurationMs: 1_000, minClipDurationMs: 1_000, maxClipDurationMs: 1_000, maxAssetReuse: 1, diversityWeight: .8 };
    const plan = await new IntelligentPlanningService(db).createPlan({ projectId: project.id, assetIds: [assetId], sentences: [{ id: 's1', text: '素材', durationMs: 1_000 }], config });
    const decisions = new IntelligentDecisionService(db);
    const preset = await decisions.createPreset({ projectId: project.id, name: 'Decision preset', config });
    const recommendation = await decisions.createRecommendation({ projectId: project.id, planId: plan.id, presetId: preset.id, profile: '短视频商品展示', confidence: .72, alternatives: ['更高多样性'], limitations: ['Fake provider 无真实视觉置信度'], evidence: { quality: plan.quality, plannerVersion: config.version } });
    assert.equal(recommendation.status, 'PROPOSED');
    assert.equal((await decisions.listPresets(project.id)).length, 1);
    assert.equal((await decisions.listRecommendations(project.id, plan.id))[0]?.evidence.plannerVersion, config.version);
  } finally { await db.end(); }
});
