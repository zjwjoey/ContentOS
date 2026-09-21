import { normalizePresentationSettings, validatePresentationSettings, type PresentationSettingsV1, type SubtitleStyleV1 } from './edit-presentation.js';
export type EditModeV1 = 'SCRIPT' | 'RANDOM';

export interface ScriptSentenceV1 {
  index: number;
  text: string;
  normalizedText: string;
  voiceStartMs?: number;
  voiceEndMs?: number;
  /** Visual placement can cover an audio gap while preserving voice timing. */
  timelineStartMs?: number;
  timelineEndMs?: number;
  durationMs?: number;
}

export interface ClipMatchingV1 {
  matchedKeywords: string[];
  matchScore: number;
  fallback: boolean;
  matchingReason: string;
  visualIntent?: string;
  selectedSource?: 'LOCAL' | 'PEXELS' | 'FAKE_PEXELS';
  selectedRole?: 'AUTHENTIC_ENTITY' | 'NEUTRAL_BROLL' | 'GENERIC_BROLL' | 'PLACE_CONTEXT';
  entityFallback?: boolean;
  allowAssetReuse?: boolean;
  query?: string;
  reason?: string;
}

export interface ManifestClip {
  assetId: string;
  sourcePath: string;
  sourceInMs: number;
  durationMs: number;
  transition: 'cut' | 'fade';
  /** Optional V1 provenance; absent on legacy manifests. */
  sentenceIndex?: number;
  sentenceText?: string;
  sceneId?: string;
  matching?: ClipMatchingV1;
  role?: 'INTRO' | 'CONTENT' | 'OUTRO';
  reviewStatus?: 'GOOD' | 'REVIEW' | 'MANUAL';
  voiceStartMs?: number;
  voiceEndMs?: number;
  timelineStartMs?: number;
  timelineEndMs?: number;
}

export interface EditManifestV0 {
  schemaVersion: 'EDIT_MANIFEST_V0';
  /** Project ownership for legacy/project video. */
  projectId?: string;
  /** Standalone ownership; mutually exclusive with projectId. */
  workspaceId?: string;
  seed: number;
  canvas: { width: number; height: number; aspectRatio: '9:16' | '16:9' | '1:1'; fps: number; fitMode?: 'FILL' | 'CONTAIN' | 'BLUR_BACKGROUND' };
  timeline: ManifestClip[];
  audio: { voiceAssetId?: string; voicePath?: string; volume: number; backgroundMusic?: { assetId?: string; path: string; volume: number; loop?: boolean; category?: string; ducking?: { enabled: boolean; voiceVolume?: number; musicVolume?: number } } };
  subtitles?: Array<{ text: string; startMs: number; endMs: number; style?: 'simple' | 'commercial' | 'emphasis'; font?: string; fontSize?: number; position?: 'top' | 'center' | 'bottom'; outline?: boolean; background?: boolean; maxLines?: number }>;
  /** Shared manifest-level style for new presentation-aware renders. */
  subtitleStyle?: SubtitleStyleV1;
  presentationSettings?: PresentationSettingsV1;
  textOverlays?: Array<{ text: string; startMs: number; endMs: number; kind?: 'HERO' | 'EVIDENCE'; style?: 'simple' | 'commercial' | 'emphasis'; fontSize?: number; position?: 'top' | 'center' | 'bottom' }>;
  metadata?: {
    briefId?: string;
    scriptRevisionId?: string;
    storyboardRevisionId?: string;
    editMode?: EditModeV1;
    preferUnusedMedia?: boolean;
    localMediaSourceRootId?: string;
    localMediaScanId?: string;
    sentences?: ScriptSentenceV1[];
    audioOffsetMs?: number;
    editorialPlanId?: string;
    editorialRevision?: number;
    templateId?: string;
    plannerVersion?: string;
    warnings?: string[];
    presentationSettings?: PresentationSettingsV1;
    rawScript?: string;
    cleanedScript?: string;
    confirmedSegments?: string[];
    digitalHumanGenerationId?: string;
  };
  output: { format: 'mp4'; videoCodec: 'mpeg4' | 'h264'; audioCodec: 'aac' };
}

export function validateEditManifest(manifest: EditManifestV0): void {
  if (manifest.schemaVersion !== 'EDIT_MANIFEST_V0') throw new Error('Unsupported edit manifest schema');
  const hasProject = typeof manifest.projectId === 'string' && manifest.projectId.trim().length > 0;
  const hasWorkspace = typeof manifest.workspaceId === 'string' && manifest.workspaceId.trim().length > 0;
  if (hasProject === hasWorkspace || manifest.timeline.length === 0) throw new Error('Edit manifest requires exactly one project or workspace owner and a timeline');
  const expectedAspect = manifest.canvas.aspectRatio === '9:16' ? 9 / 16 : manifest.canvas.aspectRatio === '16:9' ? 16 / 9 : manifest.canvas.aspectRatio === '1:1' ? 1 : 0;
  const actualAspect = manifest.canvas.height > 0 ? manifest.canvas.width / manifest.canvas.height : 0;
  if (!Number.isInteger(manifest.canvas.width) || !Number.isInteger(manifest.canvas.height) || manifest.canvas.width <= 0 || manifest.canvas.height <= 0 || manifest.canvas.width % 2 || manifest.canvas.height % 2 || !['9:16', '16:9', '1:1'].includes(manifest.canvas.aspectRatio) || Math.abs(actualAspect - expectedAspect) > 0.01) throw new Error('Edit manifest canvas dimensions are invalid');
  if (!Number.isInteger(manifest.canvas.fps) || manifest.canvas.fps < 1 || manifest.canvas.fps > 120) throw new Error('Edit manifest canvas fps is invalid');
  if (manifest.timeline.some((clip) => clip.durationMs <= 0 || clip.sourceInMs < 0)) throw new Error('Edit manifest contains invalid clip timing');
  if (manifest.metadata?.editMode !== 'RANDOM' && manifest.timeline.some((clip, index) => index > 0 && clip.assetId === manifest.timeline[index - 1]?.assetId && !clip.matching?.allowAssetReuse && !manifest.timeline[index - 1]?.matching?.allowAssetReuse && manifest.timeline.length > 1)) throw new Error('Adjacent duplicate clips are not allowed');
  if (manifest.output.format !== 'mp4') throw new Error('Only MP4 output is supported in V0');
  if (manifest.timeline.some((clip) => clip.sentenceIndex !== undefined && (!Number.isInteger(clip.sentenceIndex) || clip.sentenceIndex < 0))) throw new Error('Edit manifest sentenceIndex must be a non-negative integer');
  if (manifest.timeline.some((clip) => clip.role && !['INTRO', 'CONTENT', 'OUTRO'].includes(clip.role))) throw new Error('Edit manifest clip role is invalid');
  if (manifest.timeline.some((clip) => clip.reviewStatus && !['GOOD', 'REVIEW', 'MANUAL'].includes(clip.reviewStatus))) throw new Error('Edit manifest review status is invalid');
  if (manifest.timeline.some((clip) => (clip.voiceStartMs !== undefined || clip.voiceEndMs !== undefined) && (clip.voiceStartMs === undefined || clip.voiceEndMs === undefined || clip.voiceEndMs <= clip.voiceStartMs))) throw new Error('Edit manifest clip voice timing is invalid');
  if (manifest.timeline.some((clip) => (clip.timelineStartMs !== undefined || clip.timelineEndMs !== undefined) && (clip.timelineStartMs === undefined || clip.timelineEndMs === undefined || clip.timelineStartMs < 0 || clip.timelineEndMs <= clip.timelineStartMs))) throw new Error('Edit manifest visual timing is invalid');
  if (manifest.timeline.some((clip) => clip.matching && (clip.matching.matchScore < 0 || clip.matching.matchScore > 100 || !Array.isArray(clip.matching.matchedKeywords)))) throw new Error('Edit manifest matching metadata is invalid');
  if (manifest.subtitles?.some((cue) => cue.endMs <= cue.startMs || cue.startMs < 0 || (cue.maxLines !== undefined && (!Number.isInteger(cue.maxLines) || cue.maxLines < 1 || cue.maxLines > 3)) || (cue.fontSize !== undefined && cue.fontSize <= 0))) throw new Error('Edit manifest subtitle timing/style is invalid');
  if (manifest.textOverlays?.some((overlay) => overlay.endMs <= overlay.startMs || overlay.startMs < 0 || (overlay.fontSize !== undefined && overlay.fontSize <= 0))) throw new Error('Edit manifest text overlay timing/style is invalid');
  if (manifest.audio.backgroundMusic && (!manifest.audio.backgroundMusic.path.trim() || manifest.audio.backgroundMusic.volume < 0 || manifest.audio.backgroundMusic.volume > 1)) throw new Error('Edit manifest background music is invalid');
  if (manifest.metadata?.sentences && manifest.metadata.sentences.some((sentence) => !Number.isInteger(sentence.index) || sentence.index < 0 || !sentence.text.trim() || !sentence.normalizedText.trim() || (sentence.voiceStartMs !== undefined && sentence.voiceEndMs !== undefined && sentence.voiceEndMs <= sentence.voiceStartMs))) throw new Error('Edit manifest sentence metadata is invalid');
  if (manifest.presentationSettings) validatePresentationSettings(normalizePresentationSettings(manifest.presentationSettings));
  if (manifest.metadata?.presentationSettings) validatePresentationSettings(normalizePresentationSettings(manifest.metadata.presentationSettings));
  if (manifest.metadata && Object.values(manifest.metadata).some((value) => value !== undefined && !String(value).trim())) throw new Error('Edit manifest provenance metadata must be non-empty when present');
}
