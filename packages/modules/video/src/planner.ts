import { validateEditManifest, type EditManifestV0 } from '../../../contracts/src/index.js';

export interface PlannerAsset { id: string; storageKey: string; sourcePath: string; durationMs: number; }
export interface BuildManifestInput { projectId: string; seed: number; assets: PlannerAsset[]; targetDurationMs: number; voiceAssetId?: string; voicePath?: string; subtitleText?: string; }

function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
}

export function buildVideoManifest(input: BuildManifestInput): EditManifestV0 {
  if (input.assets.length === 0) throw new Error('Video planner requires at least one video asset');
  if (!Number.isInteger(input.targetDurationMs) || input.targetDurationMs <= 0) throw new Error('targetDurationMs must be positive');
  const random = seededRandom(input.seed);
  const shuffled = [...input.assets].sort(() => random() - 0.5);
  const timeline: EditManifestV0['timeline'] = [];
  let remaining = input.targetDurationMs;
  let cursor = 0;
  while (remaining > 0) {
    const candidate = shuffled[cursor % shuffled.length]!;
    const previous = timeline.at(-1);
    const fallback = shuffled.find((asset) => asset.id !== previous?.assetId) || candidate;
    const asset = fallback;
    const durationMs = Math.min(remaining, Math.max(1, Math.floor(asset.durationMs)));
    const maxIn = Math.max(0, asset.durationMs - durationMs);
    const sourceInMs = maxIn === 0 ? 0 : Math.floor(random() * (maxIn + 1));
    timeline.push({ assetId: asset.id, sourcePath: asset.sourcePath, sourceInMs, durationMs, transition: timeline.length ? 'fade' : 'cut' });
    remaining -= durationMs;
    cursor += 1;
  }
  const manifest: EditManifestV0 = {
    schemaVersion: 'EDIT_MANIFEST_V0', projectId: input.projectId, seed: input.seed,
    canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline,
    audio: { ...(input.voiceAssetId ? { voiceAssetId: input.voiceAssetId } : {}), ...(input.voicePath ? { voicePath: input.voicePath } : {}), volume: 1 },
    ...(input.subtitleText ? { subtitles: [{ text: input.subtitleText, startMs: 0, endMs: input.targetDurationMs }] } : {}),
    output: { format: 'mp4', videoCodec: 'mpeg4', audioCodec: 'aac' },
  };
  validateEditManifest(manifest);
  return manifest;
}
