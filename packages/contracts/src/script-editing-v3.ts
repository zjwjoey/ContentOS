export type MaterialPoolSource = 'MANUAL' | 'JIANYING_DRAFT';
export type MaterialAvailabilityV3 = 'VALID' | 'MISSING' | 'UNREADABLE' | 'DUPLICATE';
export type MaterialAiStatusV3 = 'NOT_REQUESTED' | 'PENDING' | 'READY' | 'FAILED';
export type TagEvidenceKind = 'MANUAL' | 'QWEN_VL' | 'FOLDER' | 'JIANYING_HISTORY';
export type SelectionSourceV3 = 'AUTO' | 'HISTORY' | 'MANUAL';
export type ReviewStatusV3 = 'UNREVIEWED' | 'REVIEWED' | 'REJECTED';
export const CONTROLLED_VISUAL_TAGS_V3 = ['门店外景', '门店内部', '货架', '商品特写', '顾客购物', '人多', '人少', '收银台', '街景', '仓库', '物流', '卡车', '展厅', '客户交流', '会议', '办公室', '工作人员', '产品', '装箱'] as const;
export const SCRIPT_EDITING_V3_SCORING_WEIGHTS = {
  jianyingHistoryBonus: 6,
  contentOsHistoryBonus: 5,
  manualSelectBonus: 8,
  goldBonus: 12,
  qualityBonus: 4,
  replacePenalty: 8,
  recentReusePenalty: 8,
} as const;

export function normalizeControlledVisualTagsV3(tags: readonly string[]): string[] {
  const allowed = new Set<string>(CONTROLLED_VISUAL_TAGS_V3);
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => allowed.has(tag)))];
}

export interface MaterialPoolItemV3 {
  assetId: string;
  sourcePath: string;
  fileName: string;
  durationMs: number;
  width: number;
  height: number;
  fps?: number;
  codec?: string;
  fileSize?: number;
  modifiedAt?: string;
  sourceFingerprint?: string;
  tags: string[];
  aiTags?: string[];
  availability?: MaterialAvailabilityV3;
  aiStatus?: MaterialAiStatusV3;
  disabled?: boolean;
  errorMessage?: string;
  duplicateOfAssetId?: string;
  thumbnailUrl?: string;
  gold?: boolean;
  historyUseCount?: number;
  jianyingUseCount?: number;
  candidateCount?: number;
  selectedCount?: number;
  finalUseCount?: number;
  contentOsFinalUseCount?: number;
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

export interface MaterialPoolHealthV3 {
  total: number;
  valid: number;
  missing: number;
  unreadable: number;
  duplicate: number;
  aiPending: number;
  aiReady: number;
  aiFailed: number;
  aiNotRequested: number;
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
  sourceSegmentId?: string;
  recommendedTimestampMs: number;
  fileName?: string;
  recommendedSourceInMs: number;
  recommendedSourceOutMs: number;
  semanticScore: number;
  matchingQueries: string[];
  visualEvidence: string[];
  historyBonus: number;
  jianyingHistoryBonus: number;
  contentOsHistoryBonus: number;
  manualSelectBonus: number;
  goldBonus: number;
  qualityBonus: number;
  replacePenalty: number;
  recentReusePenalty: number;
  reusePenalty: number;
  historyUseCount?: number;
  jianyingUseCount?: number;
  contentOsFinalUseCount?: number;
  gold?: boolean;
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
  reviewStatus: ReviewStatusV3;
  revision: number;
}

export type EditOperationV3 =
  | { type: 'REPLACE_CLIP'; sentenceId: string; assetId: string; sourceInMs?: number | undefined; sourceSegmentId?: string | undefined }
  | { type: 'TRIM_SOURCE'; sentenceId: string; sourceInMs: number; sourceOutMs: number }
  | { type: 'LOCK_CLIP'; sentenceId: string }
  | { type: 'UNLOCK_CLIP'; sentenceId: string }
  | { type: 'MANUAL_SELECT_CLIP'; sentenceId: string; assetId: string; sourceInMs?: number | undefined; sourceSegmentId?: string | undefined };

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
