import type { AssetVisualProfileV3, MaterialPoolItemV3 } from '../../../contracts/src/index.js';
import { qwenEndpoint } from './qwen-endpoint.js';

export interface EmbeddingProvider {
  embed(input: { texts: string[]; model?: string; signal?: AbortSignal }): Promise<{ vectors: number[][]; provider: string; model: string; dimensions: number }>;
}

export interface MaterialSemanticSearchResult { assetId: string; score: number; matchingQueries: string[]; }

export interface MaterialSemanticIndex {
  build(input: { snapshotId: string; items: MaterialPoolItemV3[]; profiles?: Map<string, AssetVisualProfileV3>; embeddings?: Map<string, number[]> }): Promise<void>;
  search(input: { snapshotId: string; queries: string[]; queryVectors?: number[][]; limit: number }): MaterialSemanticSearchResult[];
}

function tokens(value: string): Set<string> {
  const words = value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const word of [...words]) if (/^[\u3400-\u9fff]+$/u.test(word)) for (let size = 2; size <= Math.min(4, word.length); size += 1) for (let start = 0; start + size <= word.length; start += 1) words.push(word.slice(start, start + size));
  return new Set(words);
}

type Document = { assetId: string; text: string; tokens: Set<string>; vector?: number[] };

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  if (!leftNorm || !rightNorm) return 0;
  return Math.max(0, Math.min(1, (dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) + 1) / 2));
}

export class InMemoryMaterialSemanticIndex implements MaterialSemanticIndex {
  private readonly documents = new Map<string, Map<string, Document>>();

  async build(input: { snapshotId: string; items: MaterialPoolItemV3[]; profiles?: Map<string, AssetVisualProfileV3>; embeddings?: Map<string, number[]> }): Promise<void> {
    const documents = new Map<string, Document>();
    for (const item of input.items) {
      const profile = input.profiles?.get(item.assetId);
      const text = `${item.fileName} ${item.tags.join(' ')} ${profile?.summary || ''} ${(profile?.tags || []).map((tag) => tag.tag).join(' ')}`;
      const document: Document = { assetId: item.assetId, text, tokens: tokens(text) };
      const vector = input.embeddings?.get(item.assetId);
      if (vector) document.vector = vector;
      documents.set(item.assetId, document);
    }
    this.documents.set(input.snapshotId, documents);
  }

  search(input: { snapshotId: string; queries: string[]; queryVectors?: number[][]; limit: number }): MaterialSemanticSearchResult[] {
    const documents = this.documents.get(input.snapshotId);
    if (!documents) return [];
    const queryTokens = new Set(input.queries.flatMap((query) => [...tokens(query)]));
    return [...documents.values()].map((document) => {
      const matched = [...queryTokens].filter((token) => document.tokens.has(token));
      const lexicalScore = queryTokens.size ? matched.length / queryTokens.size : 0;
      const vectorScore = document.vector && input.queryVectors?.length ? Math.max(...input.queryVectors.map((vector) => cosine(document.vector!, vector))) : undefined;
      return { assetId: document.assetId, score: vectorScore === undefined ? lexicalScore : Math.max(vectorScore, lexicalScore), matchingQueries: input.queries.filter((query) => [...tokens(query)].some((token) => document.tokens.has(token))) };
    }).sort((a, b) => b.score - a.score || a.assetId.localeCompare(b.assetId)).slice(0, Math.max(1, input.limit));
  }
}

export class QwenEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly options: { endpoint?: string; apiKey?: string; model?: string; timeoutMs?: number; fetch?: typeof fetch } = {}) {}

  async embed(input: { texts: string[]; model?: string; signal?: AbortSignal }): Promise<{ vectors: number[][]; provider: string; model: string; dimensions: number }> {
    const configuredEndpoint = this.options.endpoint || process.env.QWEN_BASE_URL || process.env.QWEN_API_URL;
    const apiKey = this.options.apiKey || process.env.QWEN_API_KEY;
    const model = input.model || this.options.model || process.env.QWEN_EMBEDDING_MODEL || 'text-embedding-v3';
    if (!configuredEndpoint || !apiKey) throw new Error('QWEN_PROVIDER_NOT_CONFIGURED');
    const endpoint = qwenEndpoint(configuredEndpoint, '/embeddings');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    try {
      const response = await (this.options.fetch || fetch)(endpoint, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, input: input.texts }), signal });
      if (!response.ok) throw new Error(`QWEN_HTTP_${response.status}`);
      const body = await response.json() as { data?: Array<{ embedding?: number[] }> };
      const vectors = body.data?.map((row) => row.embedding || []) || [];
      if (vectors.length !== input.texts.length || vectors.some((vector) => vector.length === 0 || vector.some((value) => !Number.isFinite(value)))) throw new Error('QWEN_INVALID_EMBEDDING');
      return { vectors, provider: 'QWEN_EMBEDDING', model, dimensions: vectors[0]!.length };
    } catch (error) {
      if (signal.aborted) throw new Error(input.signal?.aborted ? 'QWEN_CANCELLED' : 'QWEN_TIMEOUT');
      throw error;
    } finally { clearTimeout(timeout); }
  }
}
