export interface ManifestClip {
  assetId: string;
  sourcePath: string;
  sourceInMs: number;
  durationMs: number;
  transition: 'cut' | 'fade';
  /** Storyboard provenance; omitted for standalone/random plans. */
  sceneIndex?: number;
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
  metadata?: { briefId?: string; scriptRevisionId?: string; storyboardRevisionId?: string; plannerMode?: 'RANDOM_MONTAGE' | 'STORYBOARD_V1' };
  output: { format: 'mp4'; videoCodec: 'mpeg4' | 'h264'; audioCodec: 'aac' };
}

export function validateEditManifest(manifest: EditManifestV0): void {
  if (manifest.schemaVersion !== 'EDIT_MANIFEST_V0') throw new Error('Unsupported edit manifest schema');
  const hasProject = typeof manifest.projectId === 'string' && manifest.projectId.trim().length > 0;
  const hasWorkspace = typeof manifest.workspaceId === 'string' && manifest.workspaceId.trim().length > 0;
  if (hasProject === hasWorkspace || manifest.timeline.length === 0)
    throw new Error('Edit manifest requires exactly one project or workspace owner and a timeline');
  if (manifest.canvas.width !== 1080 || manifest.canvas.height !== 1920 || manifest.canvas.aspectRatio !== '9:16')
    throw new Error('Edit manifest canvas must be 9:16 1080x1920');
  if (manifest.timeline.some((clip) => clip.durationMs <= 0 || clip.sourceInMs < 0)) throw new Error('Edit manifest contains invalid clip timing');
  if (manifest.timeline.some((clip) => clip.sceneIndex !== undefined && (!Number.isInteger(clip.sceneIndex) || clip.sceneIndex <= 0)))
    throw new Error('Edit manifest sceneIndex must be positive');
  if (manifest.timeline.some((clip, index) => index > 0 && clip.assetId === manifest.timeline[index - 1]?.assetId && manifest.timeline.length > 1))
    throw new Error('Adjacent duplicate clips are not allowed');
  if (manifest.output.format !== 'mp4') throw new Error('Only MP4 output is supported in V0');
  if (manifest.metadata && Object.values(manifest.metadata).some((value) => value !== undefined && !String(value).trim()))
    throw new Error('Edit manifest provenance metadata must be non-empty when present');
}
