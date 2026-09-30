export const INTELLIGENT_EDITING_V15_RUN_SCHEMA = 'MEDIA_ANALYSIS_RUN_V1' as const;
export const INTELLIGENT_EDITING_V15_ANALYSIS_VERSION = 'intelligent-editing-v15-foundation-1' as const;

export type MediaAnalysisRunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type MediaAnalysisProviderMode = 'FAKE' | 'REAL';
export type MediaAnalysisCapability = 'TECHNICAL' | 'SHOTS' | 'KEYFRAMES' | 'ASR' | 'VISION' | 'EMBEDDING';

export interface MediaAnalysisRunV1 {
  schemaVersion: typeof INTELLIGENT_EDITING_V15_RUN_SCHEMA;
  id: string;
  projectId: string;
  assetId: string;
  status: MediaAnalysisRunStatus;
  capabilities: MediaAnalysisCapability[];
  providerMode: MediaAnalysisProviderMode;
  analysisVersion: string;
  idempotencyKey: string;
  jobId: string | null;
  attemptCount: number;
  error: { code: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TechnicalMediaAnalysisV1 {
  runId: string;
  assetId: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number | null;
  format: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  provider: string;
  modelVersion: string;
}

export interface MediaAnalysisShotV1 {
  id: string;
  runId: string;
  assetId: string;
  shotIndex: number;
  sourceInMs: number;
  sourceOutMs: number;
  confidence: number;
  detectionVersion: string;
}

export interface MediaAnalysisKeyframeV1 {
  id: string;
  runId: string;
  assetId: string;
  shotId: string;
  timestampMs: number;
  storageKey: string;
  frameHash: string;
  status: 'REFERENCED' | 'READY' | 'FAILED';
}

export interface MediaAnalysisAsrSegmentV1 {
  id: string;
  runId: string;
  assetId: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
  confidence: number;
  provider: string;
  modelVersion: string;
}

export interface MediaAnalysisVisionResultV1 {
  id: string;
  runId: string;
  assetId: string;
  shotId: string | null;
  summary: string;
  tags: Array<{ tag: string; confidence: number; evidenceTimestampsMs: number[] }>;
  provider: string;
  modelVersion: string;
  promptVersion: string;
}

export interface MediaAnalysisEmbeddingV1 {
  id: string;
  runId: string;
  assetId: string;
  contentType: 'ASSET' | 'ASR' | 'VISION';
  contentId: string;
  textSnapshot: string;
  vector: number[];
  dimensions: number;
  provider: string;
  modelVersion: string;
}

export interface MediaAnalysisSearchResultV1 {
  assetId: string;
  score: number;
  matchingQueries: string[];
  summary: string;
  tags: string[];
}

export interface IntelligentPlannerConfigV1 {
  schemaVersion: 'INTELLIGENT_PLANNER_CONFIG_V1';
  version: string;
  targetDurationMs: number;
  minClipDurationMs: number;
  maxClipDurationMs: number;
  maxAssetReuse: number;
  diversityWeight: number;
}

export interface IntelligentEditCandidateV1 {
  id: string;
  sentenceId: string;
  assetId: string;
  shotId: string | null;
  score: number;
  selected: boolean;
  reasons: string[];
  features: { semantic: number; duration: number; quality: number; diversity: number; repetition: number };
}

export interface IntelligentEditQualityV1 {
  coverage: number;
  distinctAssetCount: number;
  repeatedAssetRatio: number;
  adjacentDuplicateCount: number;
  passed: boolean;
  issues: string[];
}

export interface IntelligentEditPlanV1 {
  schemaVersion: 'INTELLIGENT_EDIT_PLAN_V1';
  id: string;
  projectId: string;
  config: IntelligentPlannerConfigV1;
  manifest: import('./edit-manifest.js').EditManifestV0;
  candidates: IntelligentEditCandidateV1[];
  quality: IntelligentEditQualityV1;
  createdAt: string;
}

export function validateIntelligentPlannerConfigV1(value: IntelligentPlannerConfigV1): void {
  if (value.schemaVersion !== 'INTELLIGENT_PLANNER_CONFIG_V1' || !nonEmpty(value.version) || !Number.isInteger(value.targetDurationMs) || value.targetDurationMs <= 0 || !Number.isInteger(value.minClipDurationMs) || value.minClipDurationMs <= 0 || !Number.isInteger(value.maxClipDurationMs) || value.maxClipDurationMs < value.minClipDurationMs || !Number.isInteger(value.maxAssetReuse) || value.maxAssetReuse <= 0 || value.diversityWeight < 0 || value.diversityWeight > 1) throw new Error('Invalid intelligent planner config');
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function finiteNonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

export function validateMediaAnalysisRunV1(value: MediaAnalysisRunV1): void {
  if (value.schemaVersion !== INTELLIGENT_EDITING_V15_RUN_SCHEMA || !nonEmpty(value.id) || !nonEmpty(value.projectId) || !nonEmpty(value.assetId)) throw new Error('Invalid media analysis run identity');
  if (!['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(value.status)) throw new Error('Invalid media analysis run status');
  if (!value.capabilities.length || value.capabilities.some((item) => !['TECHNICAL', 'SHOTS', 'KEYFRAMES', 'ASR', 'VISION', 'EMBEDDING'].includes(item))) throw new Error('Invalid media analysis capabilities');
  if (!['FAKE', 'REAL'].includes(value.providerMode) || !nonEmpty(value.analysisVersion) || !nonEmpty(value.idempotencyKey) || !Number.isSafeInteger(value.attemptCount) || value.attemptCount < 0) throw new Error('Invalid media analysis run configuration');
}

export function validateTechnicalMediaAnalysisV1(value: TechnicalMediaAnalysisV1): void {
  if (!nonEmpty(value.runId) || !nonEmpty(value.assetId) || !finiteNonNegative(value.durationMs) || !Number.isInteger(value.width) || value.width < 0 || !Number.isInteger(value.height) || value.height < 0 || !nonEmpty(value.provider) || !nonEmpty(value.modelVersion)) throw new Error('Invalid technical media analysis');
}

export function validateMediaAnalysisShotV1(value: MediaAnalysisShotV1): void {
  if (!nonEmpty(value.id) || !nonEmpty(value.runId) || !nonEmpty(value.assetId) || !Number.isSafeInteger(value.shotIndex) || value.shotIndex < 0 || !finiteNonNegative(value.sourceInMs) || !Number.isFinite(value.sourceOutMs) || value.sourceOutMs <= value.sourceInMs || value.confidence < 0 || value.confidence > 1 || !nonEmpty(value.detectionVersion)) throw new Error('Invalid media analysis shot');
}

export function validateMediaAnalysisAsrSegmentV1(value: MediaAnalysisAsrSegmentV1): void {
  if (!nonEmpty(value.id) || !nonEmpty(value.runId) || !nonEmpty(value.assetId) || !finiteNonNegative(value.startMs) || !Number.isFinite(value.endMs) || value.endMs <= value.startMs || !nonEmpty(value.text) || value.confidence < 0 || value.confidence > 1 || !nonEmpty(value.provider) || !nonEmpty(value.modelVersion)) throw new Error('Invalid media analysis ASR segment');
}
