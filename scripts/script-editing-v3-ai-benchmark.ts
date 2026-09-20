import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { InMemoryMaterialSemanticIndex, QwenEmbeddingProvider } from '../packages/modules/video/src/index.js';
import type { AssetVisualProfileV3, MaterialPoolItemV3 } from '../packages/contracts/src/index.js';

type GoldItem = { assetId: string; fileName: string; summary?: string; tags?: string[]; durationMs?: number; width?: number; height?: number; visualProfile?: AssetVisualProfileV3 };
type GoldQuery = { id: string; text: string; usableAssetIds: string[]; forbiddenAssetIds?: string[] };
type GoldSet = { schemaVersion: 'SCRIPT_EDITING_V3_GOLD_SET_V1'; items: GoldItem[]; queries: GoldQuery[] };

function tokens(value: string): Set<string> {
  const words = value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const word of [...words]) if (/^[\u3400-\u9fff]+$/u.test(word)) for (let size = 2; size <= Math.min(4, word.length); size += 1) for (let start = 0; start + size <= word.length; start += 1) words.push(word.slice(start, start + size));
  return new Set(words);
}

function keywordRank(query: string, items: GoldItem[]): string[] {
  const queryTokens = tokens(query);
  return items.map((item) => {
    const haystack = tokens(`${item.fileName} ${(item.tags || []).join(' ')}`);
    const score = [...queryTokens].filter((token) => haystack.has(token)).length;
    return { assetId: item.assetId, score };
  }).sort((left, right) => right.score - left.score || left.assetId.localeCompare(right.assetId)).map((item) => item.assetId);
}

function rate(hits: string[], usable: Set<string>, limit: number): boolean { return hits.slice(0, limit).some((assetId) => usable.has(assetId)); }

async function embedInBatches(provider: QwenEmbeddingProvider, texts: string[], batchSize = 32): Promise<{ vectors: number[][]; model: string; elapsedMs: number }> {
  const vectors: number[][] = [];
  const started = performance.now();
  let model = '';
  for (let index = 0; index < texts.length; index += batchSize) {
    const result = await provider.embed({ texts: texts.slice(index, index + batchSize) });
    vectors.push(...result.vectors);
    model = result.model;
  }
  return { vectors, model, elapsedMs: performance.now() - started };
}

function metric(queries: GoldQuery[], rank: (query: GoldQuery) => string[]): { top1UsableRate: number; top3ContainsUsable: number; top5ContainsUsable: number; entityFalsePositiveRate: number; duplicateRate: number; latencyP50Ms: number } {
  const latencies: number[] = [];
  let top1 = 0;
  let top3 = 0;
  let top5 = 0;
  let falsePositive = 0;
  const selected = new Map<string, number>();
  for (const query of queries) {
    const start = performance.now();
    const hits = rank(query);
    latencies.push(performance.now() - start);
    const usable = new Set(query.usableAssetIds);
    if (usable.has(hits[0] || '')) top1 += 1;
    if (rate(hits, usable, 3)) top3 += 1;
    if (rate(hits, usable, 5)) top5 += 1;
    const forbidden = new Set(query.forbiddenAssetIds || []);
    if (hits.slice(0, 5).some((assetId) => forbidden.has(assetId))) falsePositive += 1;
    for (const assetId of hits.slice(0, 5)) selected.set(assetId, (selected.get(assetId) || 0) + 1);
  }
  const ordered = [...latencies].sort((left, right) => left - right);
  const p50 = ordered.length ? ordered[Math.floor((ordered.length - 1) * 0.5)]! : 0;
  const duplicateSelections = [...selected.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
  return { top1UsableRate: top1 / queries.length, top3ContainsUsable: top3 / queries.length, top5ContainsUsable: top5 / queries.length, entityFalsePositiveRate: falsePositive / queries.length, duplicateRate: queries.length ? duplicateSelections / (queries.length * 5) : 0, latencyP50Ms: Math.round(p50 * 100) / 100 };
}

async function main(): Promise<void> {
  const path = process.env.CONTENTOS_V3_GOLD_SET_PATH || process.argv[2];
  if (!path) {
    console.log(JSON.stringify({ status: 'BLOCKED_BY_DATA', reason: '请提供 CONTENTOS_V3_GOLD_SET_PATH，格式为 SCRIPT_EDITING_V3_GOLD_SET_V1。' }, null, 2));
    return;
  }
  let goldSet: GoldSet;
  try { goldSet = JSON.parse(await readFile(path, 'utf8')) as GoldSet; } catch (error) { console.log(JSON.stringify({ status: 'BLOCKED_BY_DATA', reason: `Gold Set JSON 无法读取：${error instanceof Error ? error.message : String(error)}` }, null, 2)); return; }
  const itemIds = new Set(goldSet.items?.map((item) => item.assetId));
  const labelsValid = goldSet.queries?.every((query) => query.usableAssetIds.every((assetId) => itemIds.has(assetId)) && (query.forbiddenAssetIds || []).every((assetId) => itemIds.has(assetId))) ?? false;
  if (goldSet.schemaVersion !== 'SCRIPT_EDITING_V3_GOLD_SET_V1' || !Array.isArray(goldSet.items) || !Array.isArray(goldSet.queries) || goldSet.items.length < 100 || goldSet.items.length > 300 || goldSet.queries.length < 10 || goldSet.queries.length > 20 || itemIds.size !== goldSet.items.length || !labelsValid) {
    console.log(JSON.stringify({ status: 'BLOCKED_BY_DATA', reason: 'Gold Set 必须包含 100–300 条唯一素材、10–20 条 Visual Needs，且所有人工标签必须引用已存在的 assetId。', items: goldSet.items?.length, queries: goldSet.queries?.length }, null, 2));
    return;
  }
  const missingProfiles = goldSet.items.filter((item) => item.visualProfile?.assetId !== item.assetId || item.visualProfile?.modelProvider !== 'QWEN_VL');
  if (missingProfiles.length) {
    console.log(JSON.stringify({ status: 'BLOCKED_BY_DATA', reason: '每条素材必须携带由 Qwen-VL 生成并缓存的 visualProfile；不能用 Gold Set 人工摘要或标签伪造 AI Profile。', missingProfileCount: missingProfiles.length }, null, 2));
    return;
  }
  if (!process.env.QWEN_API_KEY || !(process.env.QWEN_BASE_URL || process.env.QWEN_API_URL)) {
    console.log(JSON.stringify({ status: 'BLOCKED_BY_DATA', reason: 'AI 检索 benchmark 需要真实 Qwen API 配置；没有配置时不把 Profile 词法回退冒充 semantic 结果。', itemCount: goldSet.items.length, queryCount: goldSet.queries.length }, null, 2));
    return;
  }
  const items: MaterialPoolItemV3[] = goldSet.items.map((item) => ({ assetId: item.assetId, sourcePath: item.fileName, fileName: item.fileName, durationMs: item.durationMs || 5_000, width: item.width || 1_920, height: item.height || 1_080, tags: item.tags || [], availability: 'VALID' }));
  const profiles = new Map<string, AssetVisualProfileV3>(goldSet.items.map((item) => [item.assetId, item.visualProfile!]));
  const embeddingProvider = new QwenEmbeddingProvider();
  const documentEmbeddings = await embedInBatches(embeddingProvider, goldSet.items.map((item) => `${item.summary || ''} ${(item.tags || []).join(' ')}`));
  const queryEmbeddings = await embedInBatches(embeddingProvider, goldSet.queries.map((query) => query.text));
  if (documentEmbeddings.vectors.length !== items.length || queryEmbeddings.vectors.length !== goldSet.queries.length) throw new Error('QWEN_EMBEDDING_COUNT_MISMATCH');
  const index = new InMemoryMaterialSemanticIndex();
  await index.build({ snapshotId: 'gold-set', items, profiles, embeddings: new Map(items.map((item, index) => [item.assetId, documentEmbeddings.vectors[index]!])) });
  const queryVectorById = new Map(goldSet.queries.map((query, index) => [query.id, queryEmbeddings.vectors[index]! ]));
  const semantic = metric(goldSet.queries, (query) => index.search({ snapshotId: 'gold-set', queries: [query.text], queryVectors: [queryVectorById.get(query.id)!], limit: 5 }).map((result) => result.assetId));
  const keyword = metric(goldSet.queries, (query) => keywordRank(query.text, goldSet.items));
  console.log(JSON.stringify({ status: 'RECORDED', schemaVersion: goldSet.schemaVersion, itemCount: goldSet.items.length, queryCount: goldSet.queries.length, embeddingModel: documentEmbeddings.model || queryEmbeddings.model, embeddingLatencyMs: { documents: Math.round(documentEmbeddings.elapsedMs * 100) / 100, queries: Math.round(queryEmbeddings.elapsedMs * 100) / 100 }, keyword, semantic, delta: { top1UsableRate: semantic.top1UsableRate - keyword.top1UsableRate, top3ContainsUsable: semantic.top3ContainsUsable - keyword.top3ContainsUsable, top5ContainsUsable: semantic.top5ContainsUsable - keyword.top5ContainsUsable, entityFalsePositiveRate: semantic.entityFalsePositiveRate - keyword.entityFalsePositiveRate } }, null, 2));
}

await main();
