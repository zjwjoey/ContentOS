import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickEditOperations, applyQuickEditOperations, type QuickEditOperation } from '../../packages/modules/video/src/quick-edit.js';
import type { EditManifestV0 } from '../../packages/contracts/src/index.js';

function fixture(): EditManifestV0 {
  return {
    schemaVersion: 'EDIT_MANIFEST_V0',
    projectId: 'project-quick-edit',
    seed: 7,
    canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 },
    timeline: [
      { assetId: 'asset-a', sourcePath: 'a.mp4', sourceInMs: 0, durationMs: 1_000, transition: 'cut' },
      { assetId: 'asset-b', sourcePath: 'b.mp4', sourceInMs: 0, durationMs: 1_000, transition: 'fade' },
      { assetId: 'asset-c', sourcePath: 'c.mp4', sourceInMs: 0, durationMs: 1_000, transition: 'cut' },
    ],
    audio: { volume: 1 },
    output: { format: 'mp4', videoCodec: 'mpeg4', audioCodec: 'aac' },
  };
}

test('parses and applies trim, remove and reorder operations sequentially', () => {
  const operations = parseQuickEditOperations([
    { type: 'TRIM', clipIndex: 1, sourceInMs: 100, durationMs: 500 },
    { type: 'REMOVE', clipIndex: 0 },
    { type: 'REORDER', clipIndexes: [1, 0] },
  ]);
  const next = applyQuickEditOperations(fixture(), operations);

  assert.deepEqual(next.timeline.map((clip) => clip.assetId), ['asset-c', 'asset-b']);
  assert.equal(next.timeline[1]?.sourceInMs, 100);
  assert.equal(next.timeline[1]?.durationMs, 500);
});

test('rejects unknown operation types and malformed operation fields', () => {
  assert.throws(() => parseQuickEditOperations([{ type: 'SPLIT', clipIndex: 0 }]), /Unknown Quick Edit operation/);
  assert.throws(() => parseQuickEditOperations([{ type: 'TRIM', clipIndex: -1, sourceInMs: 0, durationMs: 100 }]), /clipIndex/);
  assert.throws(() => parseQuickEditOperations([{ type: 'TRIM', clipIndex: 0, sourceInMs: -1, durationMs: 100 }]), /sourceInMs/);
  assert.throws(() => parseQuickEditOperations([{ type: 'TRIM', clipIndex: 0, sourceInMs: 0, durationMs: 0 }]), /durationMs/);
});

test('rejects duplicate or incomplete reorder indexes', () => {
  assert.throws(() => parseQuickEditOperations([{ type: 'REORDER', clipIndexes: [0, 0, 2] }]), /permutation/);
  assert.throws(() => applyQuickEditOperations(fixture(), [{ type: 'REORDER', clipIndexes: [0, 1] }]), /permutation/);
});

test('rejects operations that leave an empty timeline', () => {
  const removeAll: QuickEditOperation[] = [
    { type: 'REMOVE', clipIndex: 0 },
    { type: 'REMOVE', clipIndex: 0 },
    { type: 'REMOVE', clipIndex: 0 },
  ];
  assert.throws(() => applyQuickEditOperations(fixture(), removeAll), /timeline/);
});

test('does not mutate the parent manifest', () => {
  const parent = fixture();
  const next = applyQuickEditOperations(parent, [{ type: 'TRIM', clipIndex: 0, sourceInMs: 20, durationMs: 200 }]);
  assert.equal(parent.timeline[0]?.sourceInMs, 0);
  assert.equal(next.timeline[0]?.sourceInMs, 20);
});
