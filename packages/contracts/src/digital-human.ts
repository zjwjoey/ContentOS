export type DigitalHumanJobType = 'SPEECH_GENERATE' | 'AVATAR_LIPSYNC_GENERATE';
export type GenerationStatus = 'PENDING' | 'RUNNING' | 'WAITING_EXTERNAL' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type ProfileStatus = 'DRAFT' | 'READY' | 'DISABLED';

export interface SpeechCapabilities {
  providerId: string;
  local: boolean;
  voiceClone: boolean;
  emotion: boolean;
  speed: boolean;
  minSpeed?: number;
  maxSpeed?: number;
  languages: string[];
  supportsReferenceAudio: boolean;
  requiresReferenceAudio: boolean;
  supportsVoiceId: boolean;
  maxTextCharacters?: number;
}

export interface SpeechGenerationRequest {
  requestId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  correlationId: string;
  text: string;
  language: string;
  speed: number;
  emotion: string;
  referenceAudioPath?: string;
  providerVoiceId?: string;
}

export interface SpeechGenerationResult {
  providerId: string;
  model: string;
  modelVersion: string;
  outputPath: string;
  durationMs: number;
  latencyMs: number;
  provenance: Record<string, unknown>;
}

export interface SpeechProvider {
  readonly providerId: string;
  getCapabilities(): Promise<SpeechCapabilities>;
  generateSpeech(request: SpeechGenerationRequest): Promise<SpeechGenerationResult>;
}

export interface AvatarCapabilities {
  providerId: string;
  local: boolean;
  videoToVideo: boolean;
  imageToVideo: boolean;
  requiresPublicUrl: boolean;
  maxDurationSeconds?: number;
  supportedFormats: string[];
  supportedAudioFormats?: string[];
}

export interface AvatarGenerationRequest {
  requestId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  correlationId: string;
  audioUrl: string;
  videoUrl: string;
  model?: string;
  parameters: Record<string, unknown>;
}

export interface AvatarExternalTask {
  externalTaskId: string;
  providerId: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  outputUrl?: string;
  model?: string;
  modelVersion?: string;
  costAmount?: number;
  costCurrency?: string;
  billingQuantity?: number;
  billingUnit?: string;
  provenance?: Record<string, unknown>;
}

export interface AvatarTaskStatus extends AvatarExternalTask {
  errorCode?: string;
  errorMessage?: string;
}

export interface AvatarProvider {
  readonly providerId: string;
  getCapabilities(): Promise<AvatarCapabilities>;
  submitLipSync(request: AvatarGenerationRequest): Promise<AvatarExternalTask>;
  getTask(externalTaskId: string): Promise<AvatarTaskStatus>;
  cancelTask?(externalTaskId: string): Promise<void>;
}

export interface ProviderMediaStaging {
  stageAsset(assetId: string, options?: { ttlSeconds?: number; projectId?: string }): Promise<{ publicUrl: string; expiresAt: string }>;
}

export interface AlignmentRequest {
  text: string;
  durationMs: number;
  language: string;
}

export interface SubtitleCue {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
}

export interface SubtitleTimeline {
  providerId: string;
  cues: SubtitleCue[];
  durationMs: number;
}

export interface AlignmentProvider {
  readonly providerId: string;
  align(request: AlignmentRequest): Promise<SubtitleTimeline>;
}

export interface VoiceProfileV1 {
  id: string;
  projectId: string;
  name: string;
  provider: string;
  referenceAssetId: string | null;
  providerVoiceId: string | null;
  language: string;
  defaultSpeed: number;
  defaultEmotion: string;
  status: ProfileStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AvatarProfileV1 {
  id: string;
  projectId: string;
  name: string;
  ownerName: string;
  status: ProfileStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AvatarClipV1 {
  id: string;
  projectId: string;
  avatarProfileId: string;
  assetId: string;
  name: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  sceneType: string | null;
  gestureLevel: string | null;
  tags: string[];
  status: ProfileStatus;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpeechGenerationV1 {
  id: string;
  projectId: string;
  voiceProfileId: string;
  provider: string;
  model: string;
  modelVersion: string | null;
  text: string;
  textHash: string;
  parameters: Record<string, unknown>;
  status: GenerationStatus;
  jobId: string;
  outputAssetId: string | null;
  durationMs: number | null;
  latencyMs: number | null;
  provenance: Record<string, unknown>;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface AvatarGenerationV1 {
  id: string;
  projectId: string;
  avatarProfileId: string;
  avatarClipId: string;
  speechAssetId: string;
  provider: string;
  model: string | null;
  modelVersion: string | null;
  externalTaskId: string | null;
  status: GenerationStatus;
  jobId: string;
  outputAssetId: string | null;
  durationMs: number | null;
  costAmount: number | null;
  costCurrency: string | null;
  billingQuantity: number | null;
  billingUnit: string | null;
  requestHash: string;
  provenance: Record<string, unknown>;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be non-empty`);
}

export function validateSpeechGenerationRequest(value: SpeechGenerationRequest): void {
  nonEmpty(value.requestId, 'requestId'); nonEmpty(value.projectId, 'projectId'); nonEmpty(value.jobId, 'jobId');
  nonEmpty(value.attemptId, 'attemptId'); nonEmpty(value.correlationId, 'correlationId'); nonEmpty(value.text, 'text'); nonEmpty(value.language, 'language'); nonEmpty(value.emotion, 'emotion');
  if (value.text.length > 100_000) throw new Error('text exceeds maximum length');
  if (!Number.isFinite(value.speed) || value.speed < 0.5 || value.speed > 2) throw new Error('speed must be between 0.5 and 2');
}

export function validateAvatarGenerationRequest(value: AvatarGenerationRequest): void {
  nonEmpty(value.requestId, 'requestId'); nonEmpty(value.projectId, 'projectId'); nonEmpty(value.jobId, 'jobId');
  nonEmpty(value.attemptId, 'attemptId'); nonEmpty(value.correlationId, 'correlationId'); nonEmpty(value.audioUrl, 'audioUrl'); nonEmpty(value.videoUrl, 'videoUrl');
  if (!value.audioUrl.startsWith('https://') && !value.audioUrl.startsWith('http://')) throw new Error('audioUrl must be http(s)');
  if (!value.videoUrl.startsWith('https://') && !value.videoUrl.startsWith('http://')) throw new Error('videoUrl must be http(s)');
}
