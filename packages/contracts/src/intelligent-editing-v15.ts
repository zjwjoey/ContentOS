export const INTELLIGENT_EDITING_V15_RUN_SCHEMA = 'MEDIA_ANALYSIS_RUN_V1' as const;
export const INTELLIGENT_EDITING_V15_ANALYSIS_VERSION = 'intelligent-editing-v15-foundation-1' as const;

export type MediaAnalysisRunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'STALE';
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
  sourceChecksum?: string | null;
  pipelineVersion?: string;
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
  segmentIndex?: number;
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
  objects?: string[];
  actions?: string[];
  location?: string | null;
  shotType?: string | null;
  cameraMotion?: string | null;
  peopleCount?: number | null;
  qualitySignals?: Record<string, number | string | boolean>;
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
  shotId?: string | null;
  textSnapshot: string;
  vector: number[];
  dimensions: number;
  provider: string;
  modelVersion: string;
  inputDigest?: string;
}

export interface MediaAnalysisSearchResultV1 {
  assetId: string;
  shotId: string | null;
  sourceInMs: number;
  sourceOutMs: number;
  score: number;
  semanticScore: number;
  lexicalScore: number;
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
  sourceInMs?: number | null;
  sourceOutMs?: number | null;
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
  semanticMatch?: number;
  durationFit?: number;
  repeatedShotRatio?: number;
  shotTypeDiversity?: number;
  consecutiveSameAssetCount?: number;
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
  manifestId?: string | null;
  videoRevisionId?: string | null;
  renderJobId?: string | null;
  sourceAnalysisRunIds?: string[];
  plannerVersion?: string;
  analysisVersion?: string | null;
  createdAt: string;
}

export interface IntelligentEditPresetV1 {
  schemaVersion: 'INTELLIGENT_EDIT_PRESET_V1';
  id: string;
  projectId: string | null;
  name: string;
  config: IntelligentPlannerConfigV1;
  enabled: boolean;
  createdAt: string;
}

export interface IntelligentEditRecommendationV1 {
  schemaVersion: 'INTELLIGENT_EDIT_RECOMMENDATION_V1';
  id: string;
  projectId: string;
  planId: string;
  presetId: string | null;
  profile: string;
  confidence: number;
  alternatives: string[];
  limitations: string[];
  evidence: Record<string, unknown>;
  status: 'PROPOSED' | 'ACCEPTED' | 'DISMISSED';
  createdAt: string;
}

export function validateIntelligentPlannerConfigV1(value: IntelligentPlannerConfigV1): void {
  if (value.schemaVersion !== 'INTELLIGENT_PLANNER_CONFIG_V1' || !nonEmpty(value.version) || !Number.isInteger(value.targetDurationMs) || value.targetDurationMs <= 0 || !Number.isInteger(value.minClipDurationMs) || value.minClipDurationMs <= 0 || !Number.isInteger(value.maxClipDurationMs) || value.maxClipDurationMs < value.minClipDurationMs || !Number.isInteger(value.maxAssetReuse) || value.maxAssetReuse <= 0 || value.diversityWeight < 0 || value.diversityWeight > 1) throw new Error('Invalid intelligent planner config');
}

export function validateIntelligentEditRecommendationV1(value: IntelligentEditRecommendationV1): void {
  if (value.schemaVersion !== 'INTELLIGENT_EDIT_RECOMMENDATION_V1' || !nonEmpty(value.id) || !nonEmpty(value.projectId) || !nonEmpty(value.planId) || !nonEmpty(value.profile) || value.confidence < 0 || value.confidence > 1 || !['PROPOSED', 'ACCEPTED', 'DISMISSED'].includes(value.status)) throw new Error('Invalid intelligent edit recommendation');
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function finiteNonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

export function validateMediaAnalysisRunV1(value: MediaAnalysisRunV1): void {
  if (value.schemaVersion !== INTELLIGENT_EDITING_V15_RUN_SCHEMA || !nonEmpty(value.id) || !nonEmpty(value.projectId) || !nonEmpty(value.assetId)) throw new Error('Invalid media analysis run identity');
  if (!['QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'STALE'].includes(value.status)) throw new Error('Invalid media analysis run status');
  if (!value.capabilities.length || value.capabilities.some((item) => !['TECHNICAL', 'SHOTS', 'KEYFRAMES', 'ASR', 'VISION', 'EMBEDDING'].includes(item))) throw new Error('Invalid media analysis capabilities');
  if (!['FAKE', 'REAL'].includes(value.providerMode) || !nonEmpty(value.analysisVersion) || !nonEmpty(value.idempotencyKey) || !Number.isSafeInteger(value.attemptCount) || value.attemptCount < 0) throw new Error('Invalid media analysis run configuration');
  if (value.sourceChecksum !== undefined && value.sourceChecksum !== null && !nonEmpty(value.sourceChecksum)) throw new Error('Invalid media analysis source checksum');
  if (value.pipelineVersion !== undefined && !nonEmpty(value.pipelineVersion)) throw new Error('Invalid media analysis pipeline version');
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

export function validateMediaAnalysisKeyframeV1(value: MediaAnalysisKeyframeV1): void {
  if (!nonEmpty(value.id) || !nonEmpty(value.runId) || !nonEmpty(value.assetId) || !nonEmpty(value.shotId) || !Number.isSafeInteger(value.timestampMs) || value.timestampMs < 0 || !nonEmpty(value.storageKey) || !nonEmpty(value.frameHash) || !['REFERENCED', 'READY', 'FAILED'].includes(value.status)) throw new Error('Invalid media analysis keyframe');
}

export function validateMediaAnalysisVisionResultV1(value: MediaAnalysisVisionResultV1): void {
  if (!nonEmpty(value.id) || !nonEmpty(value.runId) || !nonEmpty(value.assetId) || (value.shotId !== null && value.shotId !== undefined && !nonEmpty(value.shotId)) || !nonEmpty(value.summary) || !value.tags.every((tag) => nonEmpty(tag.tag) && tag.confidence >= 0 && tag.confidence <= 1 && tag.evidenceTimestampsMs.every((timestamp) => finiteNonNegative(timestamp))) || !nonEmpty(value.provider) || !nonEmpty(value.modelVersion) || !nonEmpty(value.promptVersion)) throw new Error('Invalid media analysis vision result');
  if (value.peopleCount !== undefined && value.peopleCount !== null && (!Number.isSafeInteger(value.peopleCount) || value.peopleCount < 0)) throw new Error('Invalid media analysis people count');
}

export function validateMediaAnalysisEmbeddingV1(value: MediaAnalysisEmbeddingV1): void {
  if (!nonEmpty(value.id) || !nonEmpty(value.runId) || !nonEmpty(value.assetId) || !['ASSET', 'ASR', 'VISION'].includes(value.contentType) || !nonEmpty(value.contentId) || !nonEmpty(value.textSnapshot) || !Number.isSafeInteger(value.dimensions) || value.dimensions <= 0 || value.vector.length !== value.dimensions || value.vector.some((item) => !Number.isFinite(item)) || !nonEmpty(value.provider) || !nonEmpty(value.modelVersion) || (value.inputDigest !== undefined && !nonEmpty(value.inputDigest))) throw new Error('Invalid media analysis embedding');
  if (value.contentType === 'VISION' && !nonEmpty(value.shotId)) throw new Error('Vision embedding must reference a shot');
}

export function validateIntelligentEditCandidateV1(value: IntelligentEditCandidateV1): void {
  if (!nonEmpty(value.id) || !nonEmpty(value.sentenceId) || !nonEmpty(value.assetId) || (value.shotId !== null && value.shotId !== undefined && !nonEmpty(value.shotId)) || !Number.isFinite(value.score) || !Number.isFinite(value.features.semantic) || !Number.isFinite(value.features.duration) || !Number.isFinite(value.features.quality) || !Number.isFinite(value.features.diversity) || !Number.isFinite(value.features.repetition)) throw new Error('Invalid intelligent edit candidate');
  if ((value.sourceInMs === null) !== (value.sourceOutMs === null)) throw new Error('Invalid intelligent edit candidate range');
  if (value.sourceInMs !== undefined && value.sourceInMs !== null && (!finiteNonNegative(value.sourceInMs) || !Number.isFinite(value.sourceOutMs) || value.sourceOutMs! <= value.sourceInMs)) throw new Error('Invalid intelligent edit candidate range');
}

export function validateIntelligentEditPlanV1(value: IntelligentEditPlanV1): void {
  if (value.schemaVersion !== 'INTELLIGENT_EDIT_PLAN_V1' || !nonEmpty(value.id) || !nonEmpty(value.projectId) || !Array.isArray(value.candidates) || !value.candidates.every((candidate) => { try { validateIntelligentEditCandidateV1(candidate); return true; } catch { return false; } })) throw new Error('Invalid intelligent edit plan');
}

export function validateIntelligentEditPresetV1(value: IntelligentEditPresetV1): void {
  if (value.schemaVersion !== 'INTELLIGENT_EDIT_PRESET_V1' || !nonEmpty(value.id) || (value.projectId !== null && !nonEmpty(value.projectId)) || !nonEmpty(value.name)) throw new Error('Invalid intelligent edit preset');
  validateIntelligentPlannerConfigV1(value.config);
}

export type EditingDecisionEventType = 'SHOT_ACCEPTED' | 'SHOT_REPLACED' | 'SHOT_EXCLUDED' | 'ASSET_EXCLUDED' | 'DURATION_CHANGED';
export interface EditingDecisionEventV1 { schemaVersion: 'EDITING_DECISION_EVENT_V1'; id: string; projectId: string; planId: string; sentenceId: string | null; eventType: EditingDecisionEventType; previousCandidateId: string | null; nextCandidateId: string | null; previousShotId: string | null; nextShotId: string | null; evidence: Record<string, unknown>; createdAt: string; }
export function validateEditingDecisionEventV1(value: EditingDecisionEventV1): void {
  if (value.schemaVersion !== 'EDITING_DECISION_EVENT_V1' || !nonEmpty(value.id) || !nonEmpty(value.projectId) || !nonEmpty(value.planId) || !['SHOT_ACCEPTED', 'SHOT_REPLACED', 'SHOT_EXCLUDED', 'ASSET_EXCLUDED', 'DURATION_CHANGED'].includes(value.eventType)) throw new Error('Invalid editing decision event');
}
