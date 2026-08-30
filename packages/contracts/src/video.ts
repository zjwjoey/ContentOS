import type { AssetSummaryV0 } from './asset.js';

export interface VideoWorkspaceSnapshotV0 {
  schemaVersion: 'VIDEO_WORKSPACE_V0';
  projectId: string;
  director: { briefId?: string; scriptRevisionId?: string; storyboardRevisionId?: string; ready: boolean };
  sourceAssets: AssetSummaryV0[];
  voiceAssets: AssetSummaryV0[];
  currentRender: { renderId: string; outputAssetId: string; status: string } | null;
  renderHistory: Array<{ renderId: string; outputAssetId?: string; status: string; createdAt?: string }>;
  job: { id: string; state: string; attemptCount: number; maxAttempts: number; errorCode?: string; errorMessage?: string } | null;
  approval: { targetType: 'RENDER'; targetId: string; targetRevisionId: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' } | null;
}

export function validateVideoWorkspaceSnapshotV0(value: VideoWorkspaceSnapshotV0): void {
  if (value.schemaVersion !== 'VIDEO_WORKSPACE_V0' || !value.projectId.trim()) throw new Error('Video workspace schema or project is invalid');
  for (const asset of [...value.sourceAssets, ...value.voiceAssets]) {
    if ('storageKey' in (asset as object) || 'sourcePath' in (asset as object)) throw new Error('Video workspace exposes a private asset field');
  }
  if (value.currentRender && value.approval && (value.approval.targetId !== value.currentRender.renderId || value.approval.targetRevisionId !== value.currentRender.outputAssetId)) throw new Error('Video approval target does not match current render');
  if (value.job && (!Number.isSafeInteger(value.job.attemptCount) || !Number.isSafeInteger(value.job.maxAttempts))) throw new Error('Video workspace job progress is invalid');
  if ('storageKey' in (value as object) || 'sourcePath' in (value as object)) throw new Error('Video workspace exposes a private path');
}
