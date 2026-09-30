import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../packages/database/src/client.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { IntelligentPlanningService } from '../../packages/modules/intelligence/src/index.js';

const databaseUrl = process.env.CONTENTOS_INTELLIGENCE_TEST_DATABASE_URL;

test('intelligent planning persists candidates and quality evidence in the isolated schema', { skip: !databaseUrl }, async () => {
  const db = await createDatabase(databaseUrl!);
  const suffix = randomUUID();
  try {
    const project = await new ProjectService(db).create(`Planning isolated ${suffix}`);
    const assetId = `planning-asset-${suffix}`;
    await db.query('insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [assetId, project.id, 'VIDEO', `sha256:planning-${suffix}`, 100, `objects/${assetId}.mp4`, 'READY', { durationMs: 2_000, tags: ['商品'] }]);
    await db.query('insert into project_assets(project_id,asset_id,role) values ($1,$2,$3)', [project.id, assetId, 'SOURCE']);
    const planning = new IntelligentPlanningService(db);
    const plan = await planning.createPlan({ projectId: project.id, assetIds: [assetId], sentences: [{ id: 's1', text: '商品展示', durationMs: 1_000 }], config: { schemaVersion: 'INTELLIGENT_PLANNER_CONFIG_V1', version: 'integration-v1', targetDurationMs: 1_000, minClipDurationMs: 1_000, maxClipDurationMs: 1_000, maxAssetReuse: 1, diversityWeight: .8 } });
    const stored = await planning.getPlan(project.id, plan.id);
    assert.equal(stored?.manifest.schemaVersion, 'EDIT_MANIFEST_V0');
    assert.equal(stored?.candidates.length, 1);
    assert.equal(stored?.quality.passed, true);
  } finally { await db.end(); }
});
