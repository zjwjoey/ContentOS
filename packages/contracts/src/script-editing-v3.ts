export type MaterialPoolSource = 'MANUAL' | 'JIANYING_DRAFT';
export type TagEvidenceKind = 'MANUAL' | 'QWEN_VL' | 'FOLDER' | 'JIANYING_HISTORY';
export type SelectionSourceV3 = 'AUTO' | 'HISTORY' | 'MANUAL';

export interface MaterialPoolItemV3 {
  assetId: string;
  sourcePath: string;
  fileName: string;
  durationMs: number;
  width: number;
  height: number;
  fileSize?: number;
  modifiedAt?: string;
  tags: string[];
  thumbnailUrl?: string;
  gold?: boolean;
  historyUseCount?: number;
  jianyingUseCount?: number;
  candidateCount?: number;
  selectedCount?: number;
  finalUseCount?: number;
  replaceCount?: number;
  manualSelectCount?: number;
  recentUseCount?: number;
  lastUsedAt?: string;
}

export interface MaterialPoolSnapshotV3 {
  id: string;
  workspaceId: string;
  revision: number;
  items: MaterialPoolItemV3[];
  createdAt: string;
}

export interface AssetVisualProfileV3 {
  assetId: string;
  summary: string;
  tags: Array<{ tag: string; confidence: number; timestampsMs: number[] }>;
  recommendedTimestampsMs: number[];
  modelProvider: string;
  modelName: string;
  modelVersion: string;
  promptVersion: string;
  analysisVersion: string;
  createdAt: string;
}

export interface VisualQueryV3 { sentenceId: string; query: string; model: string; promptVersion: string; }

export interface CandidateV3 {
  assetId: string;
  recommendedSourceInMs: number;
  recommendedSourceOutMs: number;
  semanticScore: number;
  matchingQueries: string[];
  visualEvidence: string[];
  historyBonus: number;
  finalScore: number;
}

export interface ClipInstanceV3 {
  id: string;
  sentenceId: string;
  assetId: string;
  sourceSegmentId?: string;
  sourceInMs: number;
  sourceOutMs: number;
  timelineStartMs: number;
  durationMs: number;
  locked: boolean;
  selectionSource: SelectionSourceV3;
  revision: number;
}

export type EditOperationV3 =
  | { type: 'REPLACE_CLIP'; sentenceId: string; assetId: string; sourceInMs?: number | undefined }
  | { type: 'TRIM_SOURCE'; sentenceId: string; sourceInMs: number; sourceOutMs: number }
  | { type: 'LOCK_CLIP'; sentenceId: string }
  | { type: 'UNLOCK_CLIP'; sentenceId: string }
  | { type: 'MANUAL_SELECT_CLIP'; sentenceId: string; assetId: string; sourceInMs?: number | undefined };

export interface SentenceEditingCardV3 {
  sentenceId: string;
  index: number;
  text: string;
  startMs: number;
  endMs: number;
  clip: ClipInstanceV3 | null;
  asset?: MaterialPoolItemV3;
  candidates: CandidateV3[];
}

export function validateAssetVisualProfileV3(value: AssetVisualProfileV3): void {
  if (!value.assetId || !value.summary || !value.modelProvider || !value.modelName || !value.promptVersion) throw new Error('ASSET_VISUAL_PROFILE_INVALID');
  if (value.tags.some((tag) => !tag.tag || tag.confidence < 0 || tag.confidence > 1 || tag.timestampsMs.some((timestamp) => timestamp < 0))) throw new Error('ASSET_VISUAL_PROFILE_TAG_INVALID');
}
