import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { representativeFrameTimestamps } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { buildVisualQueriesV3, JianyingVideoEditorDllAdapter, PlainJsonDraftAdapter, rankMaterialCandidateV3 } from '../../packages/modules/video/src/index.js';
import { InMemoryMaterialSemanticIndex, QwenEmbeddingProvider, QwenVisualQueryProvider, QwenVisualAnalysisProvider } from '../../packages/modules/video/src/index.js';
import { validateEditManifest, type EditManifestV0 } from '../../packages/contracts/src/index.js';
import { segmentationChanged } from '../../apps/web/app/edit/script/segmentation-policy.js';

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

test('V3 candidate score uses centralized history, manual, quality and reuse terms', () => {
  const baseline = rankMaterialCandidateV3({ text: '货架 商品 特写', durationMs: 3_200 }, { assetId: 'asset-base', sourcePath: 'F:/media/base.mp4', fileName: '货架商品.mp4', durationMs: 10_000, width: 1280, height: 720, tags: ['货架', '商品'] });
  const preferred = rankMaterialCandidateV3({ text: '货架 商品 特写', durationMs: 3_200 }, { assetId: 'asset-preferred', sourcePath: 'F:/media/preferred.mp4', fileName: '货架商品.mp4', durationMs: 10_000, width: 1920, height: 1080, tags: ['货架', '商品'], jianyingUseCount: 2, manualSelectCount: 3, gold: true });
  const penalized = rankMaterialCandidateV3({ text: '货架 商品 特写', durationMs: 3_200 }, { assetId: 'asset-penalized', sourcePath: 'F:/media/penalized.mp4', fileName: '货架商品.mp4', durationMs: 10_000, width: 1920, height: 1080, tags: ['货架', '商品'], replaceCount: 4, recentUseCount: 4 });
  assert.ok(preferred.finalScore > baseline.finalScore);
  assert.ok(penalized.finalScore < baseline.finalScore);
  assert.equal(preferred.goldBonus > 0, true);
  assert.equal(preferred.qualityBonus, 4);
  assert.equal(penalized.replacePenalty, 4);
  assert.equal(penalized.recentReusePenalty, 4);
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

test('Qwen visual evidence maps frame indexes to server-owned timestamps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contentos-v3-qwen-frames-'));
  const framePaths = await Promise.all([0, 1, 2].map(async (index) => { const path = join(directory, `frame-${index}.jpg`); await writeFile(path, 'fixture'); return path; }));
  try {
    const provider = new QwenVisualAnalysisProvider({ endpoint: 'https://qwen.test', apiKey: 'test-key', fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '货架', tags: [{ tag: '货架', confidence: 0.9, evidenceFrameIndexes: [2, 2, 99] }], recommendedFrameIndexes: [1, 1, 99] }) } }] }), { status: 200 }) });
    const profile = await provider.analyzeAssetFrames({ assetId: 'asset-frame-index', framePaths, frameTimestampsMs: [100, 500, 900] });
    assert.deepEqual(profile.tags[0]?.timestampsMs, [900]);
    assert.deepEqual(profile.recommendedTimestampsMs, [500]);
    assert.equal(profile.promptVersion, 'qwen-visual-v2');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Qwen visual analysis cannot turn an unverified brand guess into profile evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contentos-v3-qwen-entity-'));
  const framePath = join(directory, 'frame.jpg');
  await writeFile(framePath, 'fixture');
  try {
    const provider = new QwenVisualAnalysisProvider({ endpoint: 'https://qwen.test', apiKey: 'test-key', fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '这是 MIZAN 门店', tags: [], recommendedTimestampsMs: [] }) } }] }), { status: 200 }) });
    const profile = await provider.analyzeAssetFrames({ assetId: 'asset-entity', framePaths: [framePath] });
    assert.equal(profile.summary.includes('MIZAN'), false);
    assert.deepEqual(profile.tags, []);
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

test('Qwen visual queries are structured, bounded, and use the text model config', async () => {
  const provider = new QwenVisualQueryProvider({ endpoint: 'https://qwen.test', apiKey: 'test-key', model: 'qwen-test', fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ queries: ['人多的零售门店', '消费者购物', '商品货架'] }) } }] }), { status: 200 }) });
  const result = await provider.generateQueries({ sentenceId: 'sentence-0', text: '消费者走进低价门店' });
  assert.equal(result.provider, 'QWEN_TEXT');
  assert.equal(result.model, 'qwen-test');
  assert.equal(result.queries.length, 3);
});

test('V3 keeps confirmed segments for presentation-only changes', () => {
  const base = { mode: 'COMMA_SENTENCE' as const, delimiters: ['。', '！'] };
  assert.equal(segmentationChanged(base, { ...base }), false);
  assert.equal(segmentationChanged(base, { ...base, delimiters: ['。', '？'] }), true);
  assert.equal(segmentationChanged(base, { mode: 'PARAGRAPH' as const, delimiters: base.delimiters }), true);
});

test('Jianying draft adapters keep JSON parsing separate from unavailable DLL integration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contentos-v3-adapter-'));
  const draftDirectory = join(directory, 'draft');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(draftDirectory, { recursive: true });
  await writeFile(join(draftDirectory, 'draft_info.json'), JSON.stringify({ draft_id: 'draft-1', draft_name: '测试草稿' }));
  try {
    const readable = await new PlainJsonDraftAdapter().read(draftDirectory);
    assert.equal(readable.rootPath, draftDirectory);
    assert.equal(readable.payloads[0]?.draft_id, 'draft-1');
    assert.equal(new JianyingVideoEditorDllAdapter().status, 'UNAVAILABLE');
    await assert.rejects(new JianyingVideoEditorDllAdapter().read(draftDirectory), /JIANYING_VIDEOEDITOR_DLL_UNAVAILABLE/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Qwen embedding provider validates vectors before indexing', async () => {
  const provider = new QwenEmbeddingProvider({ endpoint: 'https://qwen.test', apiKey: 'test-key', fetch: async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }) });
  const result = await provider.embed({ texts: ['门店货架'] });
  assert.deepEqual(result.vectors, [[0.1, 0.2, 0.3]]);
  assert.equal(result.dimensions, 3);
});

test('material semantic index only searches the built snapshot', async () => {
  const index = new InMemoryMaterialSemanticIndex();
  await index.build({ snapshotId: 'snapshot-1', items: [{ assetId: 'asset-1', sourcePath: 'F:/media/shelf.mp4', fileName: '货架.mp4', durationMs: 5000, width: 1920, height: 1080, tags: ['货架'] }, { assetId: 'asset-2', sourcePath: 'F:/media/street.mp4', fileName: '街景.mp4', durationMs: 5000, width: 1920, height: 1080, tags: ['街景'] }] });
  const matches = index.search({ snapshotId: 'snapshot-1', queries: ['货架商品'], limit: 5 });
  assert.equal(matches[0]?.assetId, 'asset-1');
  assert.ok(matches.every((item) => ['asset-1', 'asset-2'].includes(item.assetId)));
  assert.deepEqual(index.search({ snapshotId: 'other-snapshot', queries: ['货架商品'], limit: 5 }), []);
});

test('material semantic index uses cached vectors when available and keeps lexical fallback', async () => {
  const index = new InMemoryMaterialSemanticIndex();
  await index.build({ snapshotId: 'snapshot-vectors', items: [{ assetId: 'asset-1', sourcePath: 'F:/media/a.mp4', fileName: '普通文件.mp4', durationMs: 5000, width: 1920, height: 1080, tags: [] }, { assetId: 'asset-2', sourcePath: 'F:/media/b.mp4', fileName: '普通文件-2.mp4', durationMs: 5000, width: 1920, height: 1080, tags: [] }], embeddings: new Map([['asset-1', [1, 0]], ['asset-2', [0, 1]]]) });
  const vectorMatches = index.search({ snapshotId: 'snapshot-vectors', queries: ['未知视觉概念'], queryVectors: [[1, 0]], limit: 2 });
  assert.equal(vectorMatches[0]?.assetId, 'asset-1');
  const lexicalMatches = index.search({ snapshotId: 'snapshot-vectors', queries: ['普通文件-2'], limit: 2 });
  assert.equal(lexicalMatches[0]?.assetId, 'asset-2');
});
