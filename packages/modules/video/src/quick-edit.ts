import { createHash } from 'node:crypto';
import { validateEditManifest, type EditManifestV0 } from '../../../contracts/src/index.js';

export type QuickEditOperation =
  | { type: 'TRIM'; clipIndex: number; sourceInMs: number; durationMs: number }
  | { type: 'REMOVE'; clipIndex: number }
  | { type: 'REORDER'; clipIndexes: number[] }
  | { type: 'REPLACE'; clipIndex: number; assetId: string; sourceInMs?: number }
  | { type: 'REROLL'; clipIndex: number; seed?: number }
  | { type: 'REMATCH'; clipIndex: number; seed?: number };

export interface AdjustmentAsset { id: string; durationMs: number; sourcePath?: string; originalName?: string; tags?: string[]; usageCount?: number; recentUsageCount?: number; lastUsedAt?: string; metadata?: Record<string, unknown>; }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function digestEditManifest(manifest: EditManifestV0): string {
  return createHash('sha256').update(stableJson(manifest)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new Error(`Quick Edit ${field} must be a non-negative integer`);
  }
  return value;
}

function parseOperation(value: unknown): QuickEditOperation {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('Quick Edit operation must have a type');
  if (value.type === 'TRIM') {
    return {
      type: 'TRIM',
      clipIndex: requireInteger(value.clipIndex, 'clipIndex'),
      sourceInMs: requireInteger(value.sourceInMs, 'sourceInMs'),
      durationMs: requireInteger(value.durationMs, 'durationMs', 1),
    };
  }
  if (value.type === 'REMOVE') {
    return { type: 'REMOVE', clipIndex: requireInteger(value.clipIndex, 'clipIndex') };
  }
  if (value.type === 'REORDER') {
    if (!Array.isArray(value.clipIndexes)) throw new Error('Quick Edit REORDER clipIndexes must be an array');
    const clipIndexes = value.clipIndexes.map((index) => requireInteger(index, 'reorder index'));
    if (new Set(clipIndexes).size !== clipIndexes.length) throw new Error('Quick Edit REORDER must be a permutation');
    return { type: 'REORDER', clipIndexes };
  }
  if (value.type === 'REPLACE') {
    if (typeof value.assetId !== 'string' || !value.assetId.trim()) throw new Error('Quick Edit REPLACE assetId is required');
    const sourceInMs = value.sourceInMs === undefined ? undefined : requireInteger(value.sourceInMs, 'sourceInMs');
    return { type: 'REPLACE', clipIndex: requireInteger(value.clipIndex, 'clipIndex'), assetId: value.assetId.trim(), ...(sourceInMs === undefined ? {} : { sourceInMs }) };
  }
  if (value.type === 'REROLL') {
    const seed = value.seed === undefined ? undefined : requireInteger(value.seed, 'seed');
    return { type: 'REROLL', clipIndex: requireInteger(value.clipIndex, 'clipIndex'), ...(seed === undefined ? {} : { seed }) };
  }
  if (value.type === 'REMATCH') {
    const seed = value.seed === undefined ? undefined : requireInteger(value.seed, 'seed');
    return { type: 'REMATCH', clipIndex: requireInteger(value.clipIndex, 'clipIndex'), ...(seed === undefined ? {} : { seed }) };
  }
  throw new Error(`Unknown Quick Edit operation: ${value.type}`);
}

function matchingTokens(value: string): string[] {
  const terms = value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const term of [...terms]) {
    if (!/^[\u3400-\u9fff]+$/u.test(term) || term.length < 2) continue;
    for (let size = 2; size <= Math.min(4, term.length); size += 1) for (let start = 0; start + size <= term.length; start += 1) terms.push(term.slice(start, start + size));
  }
  return [...new Set(terms)];
}

export interface RankedAdjustmentAsset { asset: AdjustmentAsset; matchedKeywords: string[]; matchScore: number; }
export function rankAdjustmentAssets(sentenceText: string, assets: AdjustmentAsset[]): RankedAdjustmentAsset[] {
  const required = matchingTokens(sentenceText);
  return assets.map((asset) => {
    const metadata = Object.values(asset.metadata || {}).flatMap((value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : []);
    const haystack = new Set(matchingTokens([asset.originalName || '', ...(asset.tags || []), ...metadata].join(' ')));
    const matchedKeywords = required.filter((token) => haystack.has(token));
    const usagePenalty = Math.log2((asset.usageCount ?? Number(asset.metadata?.usageCount || 0)) + 1) * 2 + Math.log2((asset.recentUsageCount ?? Number(asset.metadata?.recentUsageCount || 0)) + 1) * 3;
    return { asset, matchedKeywords, matchScore: required.length ? Math.round((matchedKeywords.length / required.length) * 100) : 0, usagePenalty };
  }).sort((a, b) => { const scoreDelta = b.matchScore - a.matchScore; return Math.abs(scoreDelta) > 5 ? scoreDelta : (b.matchScore - b.usagePenalty) - (a.matchScore - a.usagePenalty) || a.asset.id.localeCompare(b.asset.id); });
}

export function parseQuickEditOperations(value: unknown): QuickEditOperation[] {
  if (!Array.isArray(value)) throw new Error('Quick Edit operations must be an array');
  if (value.length === 0) throw new Error('Quick Edit requires at least one operation');
  if (value.length > 128) throw new Error('Quick Edit supports at most 128 operations');
  return value.map(parseOperation);
}

function assertClipIndex(index: number, length: number): void {
  if (index < 0 || index >= length) throw new Error(`Quick Edit clipIndex ${index} is out of range`);
}

function assertPermutation(indexes: number[], length: number): void {
  if (indexes.length !== length || new Set(indexes).size !== length || indexes.some((index) => index < 0 || index >= length)) {
    throw new Error('Quick Edit REORDER must be a permutation of the current timeline');
  }
}

function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
}
function assetUsagePenalty(asset: AdjustmentAsset): number { return Math.log2((asset.usageCount ?? Number(asset.metadata?.usageCount || 0)) + 1) * 2 + Math.log2((asset.recentUsageCount ?? Number(asset.metadata?.recentUsageCount || 0)) + 1) * 3; }
function sameSourceFamily(currentId: string, candidateId: string): boolean { return currentId.startsWith('local-') === candidateId.startsWith('local-'); }

export function applyQuickEditOperations(parent: EditManifestV0, operations: QuickEditOperation[], assets: AdjustmentAsset[] = []): EditManifestV0 {
  const next = structuredClone(parent);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  for (const operation of operations) {
    if (operation.type === 'TRIM') {
      assertClipIndex(operation.clipIndex, next.timeline.length);
      const clip = next.timeline[operation.clipIndex]!;
      if (clip.voiceStartMs !== undefined && clip.voiceEndMs !== undefined && operation.durationMs !== clip.voiceEndMs - clip.voiceStartMs) throw new Error('Voice-synced clip duration is read-only');
      clip.sourceInMs = operation.sourceInMs;
      clip.durationMs = operation.durationMs;
      clip.reviewStatus = 'MANUAL';
    } else if (operation.type === 'REMOVE') {
      assertClipIndex(operation.clipIndex, next.timeline.length);
      next.timeline.splice(operation.clipIndex, 1);
      if (next.timeline.length === 0) throw new Error('Quick Edit cannot leave an empty timeline');
    } else if (operation.type === 'REORDER') {
      assertPermutation(operation.clipIndexes, next.timeline.length);
      next.timeline = operation.clipIndexes.map((index) => next.timeline[index]!);
    } else if (operation.type === 'REPLACE') {
      assertClipIndex(operation.clipIndex, next.timeline.length);
      const clip = next.timeline[operation.clipIndex]!;
      const replacement = assetById.get(operation.assetId);
      if (assets.length > 0 && !replacement) throw new Error(`Quick Edit REPLACE asset ${operation.assetId} is unavailable`);
      const sourceInMs = operation.sourceInMs ?? clip.sourceInMs;
      if (replacement && (sourceInMs < 0 || sourceInMs + clip.durationMs > replacement.durationMs)) throw new Error(`Quick Edit REPLACE asset ${operation.assetId} is too short`);
      next.timeline[operation.clipIndex] = { ...clip, assetId: operation.assetId, sourceInMs, reviewStatus: 'MANUAL', ...(replacement?.sourcePath ? { sourcePath: replacement.sourcePath } : {}) };
    } else if (operation.type === 'REROLL') {
      assertClipIndex(operation.clipIndex, next.timeline.length);
      if (next.timeline[operation.clipIndex]!.role && next.timeline[operation.clipIndex]!.role !== 'CONTENT') throw new Error('Branding clips cannot be rerolled');
      if (assets.length === 0) throw new Error('Quick Edit REROLL requires available READY video assets');
      const random = seededRandom(operation.seed ?? next.seed + operation.clipIndex);
      const current = next.timeline[operation.clipIndex]!;
      const previous = next.timeline[operation.clipIndex - 1]?.assetId;
      const following = next.timeline[operation.clipIndex + 1]?.assetId;
      const candidates = assets.filter((asset) => sameSourceFamily(current.assetId, asset.id) && asset.id !== current.assetId && asset.id !== previous && asset.id !== following && asset.durationMs >= current.durationMs);
      const usage = new Map<string, number>(); for (const item of next.timeline) usage.set(item.assetId, (usage.get(item.assetId) || 0) + 1);
      const leastUsed = (pool: AdjustmentAsset[]): AdjustmentAsset[] => { if (pool.length === 0) return pool; const minimum = Math.min(...pool.map((asset) => (usage.get(asset.id) || 0) * 8 + assetUsagePenalty(asset))); return pool.filter((asset) => (usage.get(asset.id) || 0) * 8 + assetUsagePenalty(asset) === minimum); };
      const pool = leastUsed(candidates.length > 0 ? candidates : assets.filter((asset) => sameSourceFamily(current.assetId, asset.id) && asset.id !== current.assetId && asset.durationMs >= current.durationMs));
      if (pool.length === 0) throw new Error('Quick Edit REROLL has no replacement asset with sufficient duration');
      const replacement = pool[Math.floor(random() * pool.length)]!;
      const maxIn = Math.max(0, replacement.durationMs - current.durationMs);
      const sourceInMs = maxIn === 0 ? 0 : Math.floor(random() * (maxIn + 1));
      next.timeline[operation.clipIndex] = { ...current, assetId: replacement.id, sourceInMs, reviewStatus: 'MANUAL', ...(replacement.sourcePath ? { sourcePath: replacement.sourcePath } : {}) };
    } else {
      assertClipIndex(operation.clipIndex, next.timeline.length);
      if (next.timeline[operation.clipIndex]!.role && next.timeline[operation.clipIndex]!.role !== 'CONTENT') throw new Error('Branding clips cannot be rematched');
      if (assets.length === 0) throw new Error('Quick Edit REMATCH requires available video assets');
      const current = next.timeline[operation.clipIndex]!;
      const ranked = rankAdjustmentAssets(current.sentenceText || '', assets.filter((asset) => sameSourceFamily(current.assetId, asset.id)));
      const previous = next.timeline[operation.clipIndex - 1]?.assetId;
      const following = next.timeline[operation.clipIndex + 1]?.assetId;
      const eligible = ranked.filter((item) => item.asset.id !== current.assetId && item.asset.id !== previous && item.asset.id !== following && item.asset.durationMs >= current.durationMs);
      const relaxed = ranked.filter((item) => item.asset.id !== current.assetId && item.asset.durationMs >= current.durationMs);
      const selected = eligible[0] || relaxed[0];
      if (!selected) throw new Error('Quick Edit REMATCH has no replacement asset with sufficient duration');
      const maxIn = Math.max(0, selected.asset.durationMs - current.durationMs);
      const random = seededRandom(operation.seed ?? next.seed + operation.clipIndex);
      const sourceInMs = maxIn === 0 ? 0 : Math.floor(random() * (maxIn + 1));
      const fallback = selected.matchScore === 0;
      next.timeline[operation.clipIndex] = { ...current, assetId: selected.asset.id, sourceInMs, reviewStatus: 'MANUAL', ...(selected.asset.sourcePath ? { sourcePath: selected.asset.sourcePath } : {}), matching: { matchedKeywords: selected.matchedKeywords, matchScore: selected.matchScore, fallback, matchingReason: fallback ? '重新匹配未命中关键词，已使用规则兜底素材' : `重新匹配命中关键词：${selected.matchedKeywords.join('、')}` } };
    }
  }
  validateEditManifest(next);
  return next;
}
