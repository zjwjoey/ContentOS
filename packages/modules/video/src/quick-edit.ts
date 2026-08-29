import { validateEditManifest, type EditManifestV0 } from '../../../contracts/src/index.js';

export type QuickEditOperation =
  | { type: 'TRIM'; clipIndex: number; sourceInMs: number; durationMs: number }
  | { type: 'REMOVE'; clipIndex: number }
  | { type: 'REORDER'; clipIndexes: number[] };

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
  throw new Error(`Unknown Quick Edit operation: ${value.type}`);
}

export function parseQuickEditOperations(value: unknown): QuickEditOperation[] {
  if (!Array.isArray(value)) throw new Error('Quick Edit operations must be an array');
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

export function applyQuickEditOperations(parent: EditManifestV0, operations: QuickEditOperation[]): EditManifestV0 {
  const next = structuredClone(parent);
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
    } else {
      assertPermutation(operation.clipIndexes, next.timeline.length);
      next.timeline = operation.clipIndexes.map((index) => next.timeline[index]!);
    }
  }
  validateEditManifest(next);
  return next;
}
