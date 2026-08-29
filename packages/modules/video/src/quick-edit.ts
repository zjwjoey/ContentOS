import { createHash } from 'node:crypto';
import { validateEditManifest, type EditManifestV0 } from '../../../contracts/src/index.js';

export type QuickEditOperation =
  | { type: 'TRIM'; clipIndex: number; sourceInMs: number; durationMs: number }
  | { type: 'REMOVE'; clipIndex: number }
  | { type: 'REORDER'; clipIndexes: number[] }
  | { type: 'REPLACE'; clipIndex: number; assetId: string; sourceInMs?: number }
  | { type: 'REROLL'; clipIndex: number; seed?: number };

export interface AdjustmentAsset { id: string; durationMs: number; sourcePath?: string; }

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
  throw new Error(`Unknown Quick Edit operation: ${value.type}`);
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

export function applyQuickEditOperations(parent: EditManifestV0, operations: QuickEditOperation[], assets: AdjustmentAsset[] = []): EditManifestV0 {
  const next = structuredClone(parent);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  for (const operation of operations) {
    if (operation.type === 'TRIM') {
      assertClipIndex(operation.clipIndex, next.timeline.length);
      const clip = next.timeline[operation.clipIndex]!;
      clip.sourceInMs = operation.sourceInMs;
      clip.durationMs = operation.durationMs;
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
      next.timeline[operation.clipIndex] = { ...clip, assetId: operation.assetId, sourceInMs, ...(replacement?.sourcePath ? { sourcePath: replacement.sourcePath } : {}) };
    } else {
      assertClipIndex(operation.clipIndex, next.timeline.length);
      if (assets.length === 0) throw new Error('Quick Edit REROLL requires available READY video assets');
      const random = seededRandom(operation.seed ?? next.seed + operation.clipIndex);
      const current = next.timeline[operation.clipIndex]!;
      const previous = next.timeline[operation.clipIndex - 1]?.assetId;
      const following = next.timeline[operation.clipIndex + 1]?.assetId;
      const candidates = assets.filter((asset) => asset.id !== current.assetId && asset.id !== previous && asset.id !== following && asset.durationMs >= current.durationMs);
      const fallback = assets.filter((asset) => asset.id !== current.assetId && asset.durationMs >= current.durationMs);
      const pool = candidates.length > 0 ? candidates : fallback.length > 0 ? fallback : assets.filter((asset) => asset.id !== current.assetId);
      if (pool.length === 0) throw new Error('Quick Edit REROLL has no replacement asset');
      const replacement = pool[Math.floor(random() * pool.length)]!;
      const maxIn = Math.max(0, replacement.durationMs - current.durationMs);
      const sourceInMs = maxIn === 0 ? 0 : Math.floor(random() * (maxIn + 1));
      next.timeline[operation.clipIndex] = { ...current, assetId: replacement.id, sourceInMs, ...(replacement.sourcePath ? { sourcePath: replacement.sourcePath } : {}) };
    }
  }
  validateEditManifest(next);
  return next;
}
