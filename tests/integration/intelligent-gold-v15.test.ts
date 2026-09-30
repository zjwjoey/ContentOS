import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createDatabase } from '../../packages/database/src/client.js';
import { generateFixtureVideo } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { IntelligentPlanningService, MediaIntelligenceService, createFakeIntelligenceProviders } from '../../packages/modules/intelligence/src/index.js';
import type { EmbeddingProvider, IntelligenceProviders, ShotDetectionProvider, VisionProvider } from '../../packages/modules/intelligence/src/providers.js';

const databaseUrl = process.env.CONTENTOS_TEST_DATABASE_URL || process.env.DATABASE_URL;

function vectorProvider(mode: 'semantic' | 'planner'): EmbeddingProvider {
  return { embed: async ({ text, modelVersion }) => {
    if (mode === 'planner') {
      if (text.includes('门店')) return { vector: [1, 0, 0], provider: 'PLANNER_GOLD', modelVersion };
      if (text.includes('商品') && text.includes('特写')) return { vector: [0, 1, 0], provider: 'PLANNER_GOLD', modelVersion };
      if (text.includes('顾客') && text.includes('挑选')) return { vector: [0, 0, 1], provider: 'PLANNER_GOLD', modelVersion };
    }
    const vector = [0, 0, 0]; if (text.includes('门店') || text.includes('入口')) vector[0] = 1; if (text.includes('商品') || text.includes('产品') || text.includes('特写')) vector[1] = 1; if (text.includes('顾客') || text.includes('消费者') || text.includes('挑选') || text.includes('选购')) vector[2] = 1; if (!vector.some(Boolean)) vector[2] = .1;
    return { vector, provider: 'SEMANTIC_GOLD', modelVersion };
  } };
}
function shotProvider(): ShotDetectionProvider { return { detect: async () => [
  { sourceInMs: 0, sourceOutMs: 2_000, confidence: .95, detectionVersion: 'gold-shot-v1' },
  { sourceInMs: 2_000, sourceOutMs: 4_000, confidence: .94, detectionVersion: 'gold-shot-v1' },
  { sourceInMs: 4_000, sourceOutMs: 6_000, confidence: .93, detectionVersion: 'gold-shot-v1' },
] }; }
function visionProvider(): VisionProvider { return { analyze: async ({ shots }) => shots.map((shot) => {
  const summary = shot.shotIndex === 0 ? '人物进入门店' : shot.shotIndex === 1 ? '商品特写' : '顾客挑选商品';
  return { shotId: shot.id, summary, tags: [{ tag: summary, confidence: .95, evidenceTimestampsMs: [shot.sourceInMs] }], objects: [], actions: [], location: null, shotType: shot.shotIndex === 1 ? 'close' : shot.shotIndex === 0 ? 'wide' : 'medium', cameraMotion: 'static', peopleCount: null, qualitySignals: {}, provider: 'GOLD_VISION', modelVersion: 'gold-1', promptVersion: 'gold-prompt-1' };
}) }; }

async function setup(): Promise<{ db: Awaited<ReturnType<typeof createDatabase>>; root: string; storage: LocalStorageProvider; projectId: string; assetId: string }> {
  const db = await createDatabase(databaseUrl!); const root = await mkdtemp(join(tmpdir(), `contentos-intelligence-gold-${randomUUID()}-`)); const storage = new LocalStorageProvider(root); const project = await new ProjectService(db).create(`Intelligence gold ${randomUUID()}`); const source = join(root, 'source.mp4'); await generateFixtureVideo(source, process.env.FFMPEG_PATH || 'ffmpeg', 'blue', 6); await mkdir(join(root, 'objects'), { recursive: true }); const assetId = `gold-asset-${randomUUID()}`; const storageKey = `objects/${assetId}.mp4`; await copyFile(source, storage.objectPath(storageKey)); await db.query('insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [assetId, project.id, 'VIDEO', `sha256:${assetId}`, 100, storageKey, 'READY', { durationMs: 6_000, width: 640, height: 360, hasAudio: false }]); await db.query('insert into project_assets(project_id,asset_id,role) values ($1,$2,$3)', [project.id, assetId, 'SOURCE']); return { db, root, storage, projectId: project.id, assetId };
}
function goldProviders(embedding: EmbeddingProvider): IntelligenceProviders { return { ...createFakeIntelligenceProviders(), shots: shotProvider(), vision: visionProvider(), embedding }; }

test('semantic search gold ranks consumer shopping shot above unrelated shot', { skip: !databaseUrl }, async () => {
  const fixture = await setup();
  try {
    const intelligence = new MediaIntelligenceService(fixture.db, goldProviders(vectorProvider('semantic')), { storage: fixture.storage, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', keyframeRoot: join(fixture.root, 'keyframes') }); const run = await intelligence.createRun({ projectId: fixture.projectId, assetId: fixture.assetId, capabilities: ['TECHNICAL', 'SHOTS', 'VISION', 'EMBEDDING'] }); await intelligence.analyzeRun(run.id); const results = await intelligence.search(fixture.projectId, '消费者正在选购产品', 3); assert.equal(results.length, 3); assert.equal(results[0]?.shotId, `shot-${run.id}-2`); assert.ok((results[0]?.semanticScore || 0) > (results[1]?.semanticScore || 0)); assert.ok(results[0]!.sourceInMs >= 4_000); assert.ok(results[0]!.sourceOutMs <= 6_000);
  } finally { await fixture.db.end(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('planner gold maps script sentences to entrance, product close-up and shopping shots', { skip: !databaseUrl }, async () => {
  const fixture = await setup();
  try {
    const embedding = vectorProvider('planner'); const intelligence = new MediaIntelligenceService(fixture.db, goldProviders(embedding), { storage: fixture.storage, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', keyframeRoot: join(fixture.root, 'keyframes') }); const run = await intelligence.createRun({ projectId: fixture.projectId, assetId: fixture.assetId, capabilities: ['TECHNICAL', 'SHOTS', 'VISION', 'EMBEDDING'] }); await intelligence.analyzeRun(run.id); const planning = new IntelligentPlanningService(fixture.db, { storage: fixture.storage, embeddingProvider: embedding }); const plan = await planning.createPlan({ projectId: fixture.projectId, assetIds: [fixture.assetId], sentences: [{ id: 'entrance', text: '人物进入门店', durationMs: 1_500 }, { id: 'product', text: '商品特写', durationMs: 1_500 }, { id: 'shopping', text: '顾客挑选商品', durationMs: 1_500 }], config: { schemaVersion: 'INTELLIGENT_PLANNER_CONFIG_V1', version: 'planner-gold-v1', targetDurationMs: 4_500, minClipDurationMs: 1_000, maxClipDurationMs: 1_800, maxAssetReuse: 3, diversityWeight: .8 } }); const selected = plan.manifest.timeline.map((clip) => clip.sourceSegmentId); assert.deepEqual(selected, [`shot-${run.id}-0`, `shot-${run.id}-1`, `shot-${run.id}-2`]); assert.ok(plan.manifest.timeline.every((clip) => { const sourceIn = clip.sourceInMs; const sourceOut = clip.sourceOutMs; return typeof sourceIn === 'number' && typeof sourceOut === 'number' && sourceIn < sourceOut && sourceOut <= 6_000; })); assert.deepEqual(plan.sourceAnalysisRunIds, [run.id]); assert.equal(plan.manifest.metadata?.intelligentPlanId, plan.id);
  } finally { await fixture.db.end(); await rm(fixture.root, { recursive: true, force: true }); }
});
