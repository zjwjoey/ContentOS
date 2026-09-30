import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDatabase } from '../../packages/database/src/client.js';
import { generateFixtureVideo } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { FfprobeTechnicalMediaProvider, MediaIntelligenceService, createFakeIntelligenceProviders, type IntelligenceProviders } from '../../packages/modules/intelligence/src/index.js';
import type { AsrProvider, EmbeddingProvider, ShotDetectionProvider, VisionProvider } from '../../packages/modules/intelligence/src/providers.js';

const databaseUrl = process.env.CONTENTOS_TEST_DATABASE_URL || process.env.DATABASE_URL;

function error(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
function deterministicEmbedding(): EmbeddingProvider {
  return { embed: async ({ text, modelVersion }) => {
    const vector = text.includes('门店') || text.includes('入口') ? [1, 0, 0] : text.includes('商品') || text.includes('特写') ? [0, 1, 0] : text.includes('顾客') || text.includes('消费者') || text.includes('挑选') || text.includes('选购') ? [0, 0, 1] : [0, 0, 0.1];
    return { vector, provider: 'DETERMINISTIC_SEMANTIC_FIXTURE', modelVersion };
  } };
}
function providers(overrides: Partial<IntelligenceProviders> = {}): IntelligenceProviders { return { ...createFakeIntelligenceProviders(), ...overrides }; }

test('media analysis failure, retry, no-speech and cancel stages are durable and idempotent', { skip: !databaseUrl }, async () => {
  const db = await createDatabase(databaseUrl!); const root = await mkdtemp(join(tmpdir(), `contentos-analysis-closure-${randomUUID()}-`)); const storage = new LocalStorageProvider(root); const project = await new ProjectService(db).create(`Analysis closure ${randomUUID()}`);
  try {
    const validSource = join(root, 'valid.mp4'); await generateFixtureVideo(validSource, process.env.FFMPEG_PATH || 'ffmpeg', 'blue', 2); await mkdir(join(root, 'objects'), { recursive: true });
    const createAsset = async (name: string, source = validSource, metadata: Record<string, unknown> = { durationMs: 2_000, width: 640, height: 360, hasAudio: false }): Promise<string> => {
      const assetId = `asset-${name}-${randomUUID()}`; const storageKey = `objects/${assetId}.mp4`; await copyFile(source, storage.objectPath(storageKey)); await db.query('insert into assets (id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [assetId, project.id, 'VIDEO', `sha256:${assetId}`, 100, storageKey, 'READY', metadata]); await db.query('insert into project_assets(project_id,asset_id,role) values ($1,$2,$3)', [project.id, assetId, 'SOURCE']); return assetId;
    };
    const runWith = async (name: string, inputProviders: IntelligenceProviders, capabilities?: Array<'TECHNICAL' | 'SHOTS' | 'KEYFRAMES' | 'ASR' | 'VISION' | 'EMBEDDING'>, source = validSource): Promise<{ id: string; status: string }> => {
      const assetId = await createAsset(name, source); const service = new MediaIntelligenceService(db, inputProviders, { storage, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', keyframeRoot: join(root, 'keyframes') }); const run = await service.createRun({ projectId: project.id, assetId, ...(capabilities ? { capabilities } : {}) }); await assert.rejects(() => service.analyzeRun(run.id)); return (await service.getRun(project.id, run.id))!;
    };

    const corrupted = join(root, 'corrupted.mp4'); await writeFile(corrupted, Buffer.from('not a video')); const corruptedRun = await runWith('corrupted', providers({ technical: new FfprobeTechnicalMediaProvider() }), ['TECHNICAL'], corrupted); assert.equal(corruptedRun.status, 'FAILED');
    const shotFailure = await runWith('shot-failure', providers({ shots: { detect: async () => { throw error('SHOT_DETECTION_FAILED'); } } as ShotDetectionProvider }), ['TECHNICAL', 'SHOTS']); assert.equal(shotFailure.status, 'FAILED');
    const asrTimeout = await runWith('asr-timeout', providers({ asr: { transcribe: async () => { throw error('ASR_TIMEOUT'); } } as AsrProvider }), ['TECHNICAL', 'SHOTS', 'ASR']); assert.equal(asrTimeout.status, 'FAILED');
    const visionTimeout = await runWith('vision-timeout', providers({ vision: { analyze: async () => { throw error('VISION_TIMEOUT'); } } as VisionProvider }), ['TECHNICAL', 'SHOTS', 'VISION']); assert.equal(visionTimeout.status, 'FAILED');
    const embeddingFailure = await runWith('embedding-failure', providers({ embedding: { embed: async () => { throw error('EMBEDDING_FAILED'); } } as EmbeddingProvider }), ['TECHNICAL', 'SHOTS', 'ASR', 'EMBEDDING']); assert.equal(embeddingFailure.status, 'FAILED');

    const noSpeechProviders = providers({ asr: { transcribe: async () => [] } as AsrProvider }); const noSpeechAsset = await createAsset('no-speech', validSource, { durationMs: 2_000, width: 640, height: 360, hasAudio: false }); const noSpeechService = new MediaIntelligenceService(db, noSpeechProviders, { storage, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', keyframeRoot: join(root, 'keyframes') }); const noSpeechRun = await noSpeechService.createRun({ projectId: project.id, assetId: noSpeechAsset, capabilities: ['TECHNICAL', 'SHOTS', 'ASR'] }); const noSpeechResult = await noSpeechService.analyzeRun(noSpeechRun.id); assert.equal(noSpeechResult.status, 'SUCCEEDED'); assert.equal((await noSpeechService.results(project.id, noSpeechRun.id)).asr.length, 0);

    let visionAttempts = 0; const retryProviders = providers({ vision: { analyze: async (input) => { visionAttempts += 1; if (visionAttempts === 1) throw error('VISION_TIMEOUT'); return (await createFakeIntelligenceProviders().vision.analyze(input)); } } as VisionProvider }); const retryAsset = await createAsset('retry'); const retryService = new MediaIntelligenceService(db, retryProviders, { storage, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', keyframeRoot: join(root, 'keyframes') }); const retryRun = await retryService.createRun({ projectId: project.id, assetId: retryAsset }); await assert.rejects(() => retryService.analyzeRun(retryRun.id), /VISION_TIMEOUT/); assert.equal((await retryService.getRun(project.id, retryRun.id))?.status, 'FAILED'); const retryResult = await retryService.analyzeRun(retryRun.id); assert.equal(retryResult.status, 'SUCCEEDED'); assert.equal(visionAttempts, 2); const retryCounts = (await db.query('select (select count(*) from media_analysis_shots where run_id=$1)::int as shots,(select count(*) from media_analysis_vision_results where run_id=$1)::int as vision,(select count(*) from media_analysis_asr_segments where run_id=$1)::int as asr,(select count(*) from media_analysis_embeddings where run_id=$1)::int as embeddings', [retryRun.id])).rows[0]; assert.deepEqual(retryCounts, { shots: 1, vision: 1, asr: 1, embeddings: 3 });

    const cancelStage = async (stage: 'ASR' | 'VISION' | 'KEYFRAMES'): Promise<string> => { const controller = new AbortController(); const stageProviders = providers(); const capabilities = stage === 'ASR' ? ['TECHNICAL', 'SHOTS', 'ASR'] as const : stage === 'VISION' ? ['TECHNICAL', 'SHOTS', 'VISION'] as const : ['TECHNICAL', 'SHOTS', 'KEYFRAMES'] as const; if (stage === 'ASR') stageProviders.asr = { transcribe: async () => { controller.abort(); return []; } }; if (stage === 'VISION') stageProviders.vision = { analyze: async () => { controller.abort(); return []; } }; if (stage === 'KEYFRAMES') stageProviders.shots = { detect: async () => { controller.abort(); return [{ sourceInMs: 0, sourceOutMs: 1_000, confidence: 1, detectionVersion: 'cancel-fixture' }]; } }; const assetId = await createAsset(`cancel-${stage.toLowerCase()}`); const service = new MediaIntelligenceService(db, stageProviders, { storage, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', keyframeRoot: join(root, 'keyframes') }); const run = await service.createRun({ projectId: project.id, assetId, capabilities: [...capabilities] }); await assert.rejects(() => service.analyzeRun(run.id, controller.signal), /aborted|ABORT_ERR|canceled|cancelled/i); return (await service.getRun(project.id, run.id))!.status; };
    assert.equal(await cancelStage('ASR'), 'CANCELLED'); assert.equal(await cancelStage('VISION'), 'CANCELLED'); assert.equal(await cancelStage('KEYFRAMES'), 'CANCELLED');
    const fingerprintAsset = await createAsset('fingerprint'); const fingerprintProviders = createFakeIntelligenceProviders(); const fingerprintService = new MediaIntelligenceService(db, fingerprintProviders, { storage, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', keyframeRoot: join(root, 'keyframes') }); const firstFingerprintRun = await fingerprintService.createRun({ projectId: project.id, assetId: fingerprintAsset, capabilities: ['TECHNICAL'] }); const reusedFingerprintRun = await fingerprintService.createRun({ projectId: project.id, assetId: fingerprintAsset, capabilities: ['TECHNICAL'] }); assert.equal(reusedFingerprintRun.id, firstFingerprintRun.id); assert.ok(firstFingerprintRun.analysisFingerprint); assert.ok(firstFingerprintRun.configSnapshot); const changedProviders = createFakeIntelligenceProviders(); changedProviders.descriptors.embedding.modelVersion = 'fake-embedding-v2'; const changedFingerprintRun = await new MediaIntelligenceService(db, changedProviders, { storage, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', keyframeRoot: join(root, 'keyframes') }).createRun({ projectId: project.id, assetId: fingerprintAsset, capabilities: ['TECHNICAL'] }); assert.notEqual(changedFingerprintRun.id, firstFingerprintRun.id);
  } finally { await db.end(); await rm(root, { recursive: true, force: true }); }
});
