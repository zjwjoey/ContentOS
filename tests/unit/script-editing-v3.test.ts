import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { representativeFrameTimestamps } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { buildVisualQueriesV3, rankMaterialCandidateV3 } from '../../packages/modules/video/src/index.js';
import { QwenVisualAnalysisProvider } from '../../packages/modules/video/src/visual-analysis.js';
import { validateEditManifest, type EditManifestV0 } from '../../packages/contracts/src/index.js';

test('V3 visual queries are reproducible and bounded', () => {
  const queries = buildVisualQueriesV3('越来越多消费者走进低价门店');
  assert.ok(queries.length >= 3 && queries.length <= 5);
  assert.deepEqual(queries, buildVisualQueriesV3('越来越多消费者走进低价门店'));
});

test('V3 representative frames use five cached percentage timestamps', () => {
  assert.deepEqual(representativeFrameTimestamps(10_000), [1_000, 3_000, 5_000, 7_000, 9_000]);
  assert.deepEqual(representativeFrameTimestamps(1), [0, 0, 0, 0, 0]);
  assert.deepEqual(representativeFrameTimestamps(0), []);
});

test('V3 candidate range preserves sentence duration', () => {
  const candidate = rankMaterialCandidateV3({ text: '货架 商品 特写', durationMs: 3_200 }, { assetId: 'asset-1', sourcePath: 'F:/media/a.mp4', fileName: '货架商品.mp4', durationMs: 10_000, width: 1920, height: 1080, tags: ['货架', '商品'] });
  assert.equal(candidate.recommendedSourceOutMs - candidate.recommendedSourceInMs, 3_200);
  assert.ok(candidate.finalScore > 0);
});

test('V3 sourceOut is validated against timeline duration', () => {
  const manifest: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', workspaceId: 'workspace-v3', seed: 1, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline: [{ assetId: 'asset-1', sourcePath: 'F:/media/a.mp4', sourceInMs: 800, sourceOutMs: 4_000, durationMs: 3_200, transition: 'cut', sentenceId: 'sentence-0', locked: false, selectionSource: 'AUTO', revision: 1 }], audio: { volume: 1 }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } };
  assert.doesNotThrow(() => validateEditManifest(manifest));
  assert.throws(() => validateEditManifest({ ...manifest, timeline: [{ ...manifest.timeline[0]!, sourceOutMs: 4_001 }] }), /invalid clip timing/);
});

test('Qwen invalid JSON is rejected before a visual profile can be accepted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contentos-v3-qwen-'));
  const framePath = join(directory, 'frame.jpg');
  await writeFile(framePath, 'fixture');
  try {
    const provider = new QwenVisualAnalysisProvider({ endpoint: 'https://qwen.test', apiKey: 'test-key', fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{invalid' } }] }), { status: 200 }) });
    await assert.rejects(provider.analyzeAssetFrames({ assetId: 'asset-1', framePaths: [framePath] }), /QWEN_INVALID_JSON/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Qwen visual tags are bounded by the controlled catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contentos-v3-qwen-tags-'));
  const framePath = join(directory, 'frame.jpg');
  await writeFile(framePath, 'fixture');
  try {
    const provider = new QwenVisualAnalysisProvider({ endpoint: 'https://qwen.test', apiKey: 'test-key', fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '门店内部', tags: [{ tag: '门店内部', confidence: 0.9, timestampsMs: [100] }, { tag: 'MIZAN', confidence: 0.99, timestampsMs: [100] }], recommendedTimestampsMs: [100] }) } }] }), { status: 200 }) });
    const profile = await provider.analyzeAssetFrames({ assetId: 'asset-1', framePaths: [framePath] });
    assert.deepEqual(profile.tags.map((tag) => tag.tag), ['门店内部']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Qwen timeout is normalized for the durable job retry boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contentos-v3-qwen-timeout-'));
  const framePath = join(directory, 'frame.jpg');
  await writeFile(framePath, 'fixture');
  try {
    const provider = new QwenVisualAnalysisProvider({ endpoint: 'https://qwen.test', apiKey: 'test-key', timeoutMs: 1, fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }) });
    await assert.rejects(provider.analyzeAssetFrames({ assetId: 'asset-1', framePaths: [framePath] }), /QWEN_TIMEOUT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
