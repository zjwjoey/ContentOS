import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { concatDraftPreviewFragments, generateFixtureVideo, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { FfmpegShotDetectionProvider, FfprobeTechnicalMediaProvider, createIntelligenceProviders } from '../../packages/modules/intelligence/src/index.js';
import { cosineSimilarity, hybridSemanticScore, semanticTokens } from '../../packages/modules/video/src/index.js';

test('real FFmpeg scene detector finds boundaries in a red/blue/green fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-shot-detection-v15-')); const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'; const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
  try {
    const parts = await Promise.all(['red', 'blue', 'green'].map(async (color, index) => { const path = join(root, `${index}-${color}.mp4`); await generateFixtureVideo(path, ffmpegPath, color, 2); return path; })); const output = join(root, 'three-scenes.mp4'); await concatDraftPreviewFragments({ fragmentPaths: parts, outputPath: output, ffmpegPath, ffprobePath }); const media = await probeMedia(output, ffprobePath); const technical = await new FfprobeTechnicalMediaProvider(ffprobePath).probe({ assetId: 'fixture', runId: 'run', metadata: {}, sourcePath: output }); assert.equal(technical.width, 640); assert.equal(technical.height, 360); assert.ok(technical.durationMs > 0); const shots = await new FfmpegShotDetectionProvider(ffmpegPath).detect({ assetId: 'fixture', runId: 'run', sourcePath: output, durationMs: media.durationMs }); assert.ok(shots.length >= 3, `expected 3 scenes, got ${shots.length}`); assert.ok(shots.every((shot) => shot.sourceInMs < shot.sourceOutMs && shot.detectionVersion === 'shot-detection-v1'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real provider mode is explicit and semantic ranking is weighted', () => {
  const providers = createIntelligenceProviders({ realProvidersEnabled: false }); assert.equal(providers.mode, 'FAKE'); assert.ok(semanticTokens('消费者正在选购产品').has('选购')); const score = hybridSemanticScore({ semanticScore: 0.9, lexicalScore: 0.1, semanticWeight: 0.7, lexicalWeight: 0.3 }); assert.equal(score, 0.66); assert.equal(cosineSimilarity([1, 0], [1, 0]), 1); assert.equal(cosineSimilarity([1, 0], [0, 1]), 0.5); assert.throws(() => hybridSemanticScore({ semanticScore: 0, lexicalScore: 0, semanticWeight: 0, lexicalWeight: 0 }), /SEMANTIC_WEIGHTS_INVALID/);
});

test('technical provider rejects a real analysis without a source path', async () => {
  await assert.rejects(() => new FfprobeTechnicalMediaProvider().probe({ assetId: 'asset', runId: 'run', metadata: {} }), /REAL_TECHNICAL_SOURCE_PATH_REQUIRED/);
});
