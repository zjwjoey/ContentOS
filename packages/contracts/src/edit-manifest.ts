export type EditModeV1 = 'SCRIPT' | 'RANDOM';

export interface ScriptSentenceV1 {
  index: number;
  text: string;
  normalizedText: string;
}

export interface ClipMatchingV1 {
  matchedKeywords: string[];
  matchScore: number;
  fallback: boolean;
  matchingReason: string;
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
}

export interface EditManifestV0 {
  schemaVersion: 'EDIT_MANIFEST_V0';
  /** Project ownership for legacy/project video. */
  projectId?: string;
  /** Standalone ownership; mutually exclusive with projectId. */
  workspaceId?: string;
  seed: number;
  canvas: { width: 1080; height: 1920; aspectRatio: '9:16'; fps: 30 };
  timeline: ManifestClip[];
  audio: { voiceAssetId?: string; voicePath?: string; volume: number };
  subtitles?: Array<{ text: string; startMs: number; endMs: number }>;
  metadata?: {
    briefId?: string;
    scriptRevisionId?: string;
    storyboardRevisionId?: string;
    editMode?: EditModeV1;
    sentences?: ScriptSentenceV1[];
  };
  output: { format: 'mp4'; videoCodec: 'mpeg4' | 'h264'; audioCodec: 'aac' };
}

export function validateEditManifest(manifest: EditManifestV0): void {
  if (manifest.schemaVersion !== 'EDIT_MANIFEST_V0') throw new Error('Unsupported edit manifest schema');
  const hasProject = typeof manifest.projectId === 'string' && manifest.projectId.trim().length > 0;
  const hasWorkspace = typeof manifest.workspaceId === 'string' && manifest.workspaceId.trim().length > 0;
  if (hasProject === hasWorkspace || manifest.timeline.length === 0) throw new Error('Edit manifest requires exactly one project or workspace owner and a timeline');
  if (manifest.canvas.width !== 1080 || manifest.canvas.height !== 1920 || manifest.canvas.aspectRatio !== '9:16') throw new Error('Edit manifest canvas must be 9:16 1080x1920');
  if (manifest.timeline.some((clip) => clip.durationMs <= 0 || clip.sourceInMs < 0)) throw new Error('Edit manifest contains invalid clip timing');
  if (manifest.metadata?.editMode !== 'RANDOM' && manifest.timeline.some((clip, index) => index > 0 && clip.assetId === manifest.timeline[index - 1]?.assetId && manifest.timeline.length > 1)) throw new Error('Adjacent duplicate clips are not allowed');
  if (manifest.output.format !== 'mp4') throw new Error('Only MP4 output is supported in V0');
  if (manifest.timeline.some((clip) => clip.sentenceIndex !== undefined && (!Number.isInteger(clip.sentenceIndex) || clip.sentenceIndex < 0))) throw new Error('Edit manifest sentenceIndex must be a non-negative integer');
  if (manifest.timeline.some((clip) => clip.matching && (clip.matching.matchScore < 0 || clip.matching.matchScore > 100 || !Array.isArray(clip.matching.matchedKeywords)))) throw new Error('Edit manifest matching metadata is invalid');
  if (manifest.metadata?.sentences && manifest.metadata.sentences.some((sentence) => !Number.isInteger(sentence.index) || sentence.index < 0 || !sentence.text.trim() || !sentence.normalizedText.trim())) throw new Error('Edit manifest sentence metadata is invalid');
  if (manifest.metadata && Object.values(manifest.metadata).some((value) => value !== undefined && !String(value).trim())) throw new Error('Edit manifest provenance metadata must be non-empty when present');
}
