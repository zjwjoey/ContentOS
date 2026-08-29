import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVideoWorkspaceSnapshotV0, type VideoWorkspaceSnapshotV0 } from '../../packages/contracts/src/index.js';

test('VideoWorkspaceSnapshotV0 exposes current Director pair, safe assets, renders and exact Approval target', () => {
  const value: VideoWorkspaceSnapshotV0 = { schemaVersion: 'VIDEO_WORKSPACE_V0', projectId: 'project-1', director: { briefId: 'brief-1', scriptRevisionId: 'script-1', storyboardRevisionId: 'storyboard-1', ready: true }, sourceAssets: [{ id: 'asset-1', kind: 'VIDEO', lifecycle: 'READY', byteSize: 100, checksum: 'sha256:' + 'a'.repeat(64), originalName: 'a.mp4', metadata: { durationMs: 1000, width: 1080, height: 1920, format: 'mp4' } }], voiceAssets: [], currentRender: { renderId: 'render-1', outputAssetId: 'asset-out', status: 'SUCCEEDED' }, renderHistory: [], job: null, approval: { targetType: 'RENDER', targetId: 'render-1', targetRevisionId: 'asset-out', status: 'PENDING' } };
  validateVideoWorkspaceSnapshotV0(value);
  assert.ok(value.approval);
  assert.equal(value.approval.targetRevisionId, value.currentRender?.outputAssetId);
});

test('VideoWorkspaceSnapshotV0 rejects private paths and mismatched approval target', () => {
  assert.throws(() => validateVideoWorkspaceSnapshotV0({ schemaVersion: 'VIDEO_WORKSPACE_V0', projectId: 'project-1', director: { ready: false }, sourceAssets: [], voiceAssets: [], currentRender: null, renderHistory: [], job: null, approval: { targetType: 'RENDER', targetId: 'render-1', targetRevisionId: 'asset-1', status: 'PENDING' }, storageKey: 'renders/private.mp4' } as never));
});
