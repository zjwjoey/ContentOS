import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMediaAnalysisRunV1, validateMediaAnalysisShotV1, type MediaAnalysisRunV1 } from '../../packages/contracts/src/index.js';
import { FakeAsrProvider, FakeEmbeddingProvider, FakeTechnicalMediaProvider, FakeVisionProvider } from '../../packages/modules/intelligence/src/index.js';

test('Intelligent Editing V1.5 contracts reject invalid state and accept a valid run', () => {
  const run: MediaAnalysisRunV1 = { schemaVersion: 'MEDIA_ANALYSIS_RUN_V1', id: 'run-1', projectId: 'project-1', assetId: 'asset-1', status: 'QUEUED', capabilities: ['TECHNICAL', 'SHOTS'], providerMode: 'FAKE', analysisVersion: 'v1', idempotencyKey: 'key-1', jobId: null, attemptCount: 0, error: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null };
  validateMediaAnalysisRunV1(run);
  assert.throws(() => validateMediaAnalysisShotV1({ id: 'shot', runId: 'run', assetId: 'asset', shotIndex: 0, sourceInMs: 4, sourceOutMs: 3, confidence: .5, detectionVersion: 'v1' }), /Invalid media analysis shot/);
});

test('fake intelligence providers are deterministic and offline', async () => {
  const technical = await new FakeTechnicalMediaProvider().probe({ assetId: 'asset-1', runId: 'run-1', metadata: { durationMs: 4_000, width: 720, height: 1280 } });
  assert.equal(technical.durationMs, 4_000);
  const asr = await new FakeAsrProvider().transcribe({ assetId: 'asset-1', runId: 'run-1', durationMs: 4_000, metadata: { transcript: '测试语音' } });
  assert.equal(asr[0]?.text, '测试语音');
  const vision = await new FakeVisionProvider().analyze({ assetId: 'asset-1', runId: 'run-1', shots: [{ id: 'shot-1', runId: 'run-1', assetId: 'asset-1', shotIndex: 0, sourceInMs: 0, sourceOutMs: 4_000, confidence: .5, detectionVersion: 'v1' }], metadata: { tags: ['人物'] } });
  assert.equal(vision[0]?.tags[0]?.tag, '人物');
  const first = await new FakeEmbeddingProvider().embed({ text: 'same', modelVersion: 'fake-1' });
  const second = await new FakeEmbeddingProvider().embed({ text: 'same', modelVersion: 'fake-1' });
  assert.deepEqual(first.vector, second.vector);
});
