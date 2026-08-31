import { validateEditManifest, type EditManifestV0 } from '../../../contracts/src/index.js';

export interface PlannerAsset { id: string; storageKey: string; sourcePath: string; durationMs: number; }
export interface StoryboardPlannerAsset extends PlannerAsset { originalName?: string; tags?: string[]; metadata?: Record<string, unknown>; }
export interface StoryboardPlannerScene { sceneIndex: number; assetKeywords: string[]; durationHintSeconds: number; }
export interface BuildManifestInput { projectId?: string; workspaceId?: string; seed: number; assets: PlannerAsset[]; targetDurationMs: number; voiceAssetId?: string; voicePath?: string; subtitleText?: string; metadata?: EditManifestV0['metadata']; }

function ownerOf(input: { projectId?: string; workspaceId?: string }): { projectId: string } | { workspaceId: string } {
  if (input.projectId !== undefined) return { projectId: input.projectId };
  if (input.workspaceId !== undefined) return { workspaceId: input.workspaceId };
  throw new Error('Video planner requires exactly one projectId or workspaceId');
}

function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
}

export function buildVideoManifest(input: BuildManifestInput): EditManifestV0 {
  if (input.assets.length === 0) throw new Error('Video planner requires at least one video asset');
  if (!Number.isInteger(input.targetDurationMs) || input.targetDurationMs <= 0) throw new Error('targetDurationMs must be positive');
  const owner = ownerOf(input);
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
    schemaVersion: 'EDIT_MANIFEST_V0', ...owner, seed: input.seed,
    canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline,
    audio: { ...(input.voiceAssetId ? { voiceAssetId: input.voiceAssetId } : {}), ...(input.voicePath ? { voicePath: input.voicePath } : {}), volume: 1 },
    ...(input.subtitleText ? { subtitles: [{ text: input.subtitleText, startMs: 0, endMs: input.targetDurationMs }] } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' },
  };
  validateEditManifest(manifest);
  return manifest;
}

export interface RandomMontageInput {
  projectId?: string;
  workspaceId?: string;
  seed: number;
  assets: PlannerAsset[];
  targetDurationMs: number;
  voiceAssetId?: string;
  voicePath?: string;
  minClipDurationMs?: number;
  maxClipDurationMs?: number;
}

/** Deterministic, source-rotating planner used by Standalone Quick Edit. */
export function buildRandomMontageManifest(input: RandomMontageInput): EditManifestV0 {
  const minClipDurationMs = input.minClipDurationMs ?? 2_000;
  const maxClipDurationMs = input.maxClipDurationMs ?? 5_000;
  if (!Number.isInteger(minClipDurationMs) || minClipDurationMs <= 0 || !Number.isInteger(maxClipDurationMs) || maxClipDurationMs < minClipDurationMs) throw new Error('Random Montage clip bounds are invalid');
  if (input.assets.length === 0) throw new Error('Random Montage requires at least one video asset');
  if (input.assets.some((asset) => !Number.isFinite(asset.durationMs) || asset.durationMs <= 0)) throw new Error('Random Montage requires every video asset to have a positive duration');
  if (!Number.isInteger(input.targetDurationMs) || input.targetDurationMs <= 0) throw new Error('targetDurationMs must be positive');
  const owner = ownerOf(input);
  const random = seededRandom(input.seed);
  const assets = [...input.assets].sort((a, b) => a.id.localeCompare(b.id));
  const usage = new Map(assets.map((asset) => [asset.id, 0]));
  const timeline: EditManifestV0['timeline'] = [];
  let remaining = input.targetDurationMs;
  while (remaining > 0) {
    const previous = timeline.at(-1)?.assetId;
    const lowestUsage = Math.min(...assets.map((asset) => usage.get(asset.id) || 0));
    const rotation = assets.filter((asset) => (usage.get(asset.id) || 0) === lowestUsage && asset.id !== previous);
    const candidates = rotation.length > 0 ? rotation : assets.filter((asset) => asset.id !== previous);
    const asset = candidates[Math.floor(random() * candidates.length)] || assets[0]!;
    const availableMs = Math.max(1, Math.floor(asset.durationMs));
    const maxDurationMs = Math.min(remaining, maxClipDurationMs, availableMs);
    const minDurationMs = Math.min(minClipDurationMs, maxDurationMs);
    const durationMs = remaining <= maxClipDurationMs && remaining <= availableMs
      ? remaining
      : minDurationMs + Math.floor(random() * (maxDurationMs - minDurationMs + 1));
    if (durationMs <= 0) throw new Error('Random Montage generated an invalid clip duration');
    const maxIn = Math.max(0, asset.durationMs - durationMs);
    const sourceInMs = maxIn === 0 ? 0 : Math.floor(random() * (maxIn + 1));
    timeline.push({ assetId: asset.id, sourcePath: asset.sourcePath, sourceInMs, durationMs, transition: timeline.length ? 'cut' : 'cut' });
    usage.set(asset.id, (usage.get(asset.id) || 0) + 1);
    remaining -= durationMs;
  }
  return validateAndReturn({ schemaVersion: 'EDIT_MANIFEST_V0', ...owner, seed: input.seed, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline, audio: { ...(input.voiceAssetId ? { voiceAssetId: input.voiceAssetId } : {}), ...(input.voicePath ? { voicePath: input.voicePath } : {}), volume: 1 }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } });
}

export interface StoryboardPlannerInput { projectId: string; seed: number; storyboardRevisionId: string; scenes: StoryboardPlannerScene[]; assets: StoryboardPlannerAsset[]; targetDurationMs?: number; voiceAssetId?: string; voicePath?: string; }
export interface StoryboardPlannerDecision { sceneIndex: number; assetId: string; score: number; matchedKeywords: string[]; fallback: boolean; }
export interface StoryboardPlannerResult { manifest: EditManifestV0; decisions: StoryboardPlannerDecision[]; }

function tokens(values: string[]): string[] { return [...new Set(values.flatMap((value) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).map((token) => token.trim()).filter((token) => token.length >= 2)))]; }
/** Deterministic keyword planner; it only uses approved storyboard keywords and safe asset metadata. */
export function buildStoryboardVideoManifest(input: StoryboardPlannerInput): StoryboardPlannerResult {
  if (!input.scenes.length || !input.assets.length) throw new Error('Storyboard planner requires scenes and assets');
  const targetDurationMs = input.targetDurationMs ?? Math.max(1_000, Math.round(input.scenes.reduce((total, scene) => total + scene.durationHintSeconds, 0) * 1000));
  const sorted = [...input.assets].sort((a, b) => a.id.localeCompare(b.id));
  const decisions: StoryboardPlannerDecision[] = []; const timeline: EditManifestV0['timeline'] = [];
  for (const scene of [...input.scenes].sort((a, b) => a.sceneIndex - b.sceneIndex)) {
    const required = tokens(scene.assetKeywords); const previous = timeline.at(-1)?.assetId;
    const requestedDurationMs = Math.max(1, Math.round(scene.durationHintSeconds * 1000));
    const durationMs = Math.min(requestedDurationMs, remainingForTarget(targetDurationMs, timeline));
    const ranked = sorted.map((asset) => { const haystack = tokens([asset.originalName || '', ...(asset.tags || []), ...Object.values(asset.metadata || {}).filter((value): value is string => typeof value === 'string')]); const matched = required.filter((word) => haystack.includes(word)); const score = required.length ? Math.round((matched.length / required.length) * 100) : 0; return { asset, matched, score }; }).sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));
    const eligible = ranked.filter((item) => item.asset.id !== previous && Math.floor(item.asset.durationMs) >= durationMs);
    const best = eligible[0];
    if (!best) {
      if (ranked.length === 1 && ranked[0]!.asset.id === previous) throw new Error('Storyboard planner cannot place adjacent scenes with only one asset');
      throw new Error(`Storyboard planner has no asset long enough for scene ${scene.sceneIndex}`);
    }
    const fallback = best.score === 0; const maxIn = Math.max(0, Math.floor(best.asset.durationMs - durationMs)); const sourceInMs = maxIn > 0 ? (Math.abs(input.seed + scene.sceneIndex) % (maxIn + 1)) : 0;
    timeline.push({ assetId: best.asset.id, sourcePath: best.asset.sourcePath, sourceInMs, durationMs, transition: timeline.length ? 'cut' : 'cut' }); decisions.push({ sceneIndex: scene.sceneIndex, assetId: best.asset.id, score: best.score, matchedKeywords: best.matched, fallback });
  }
  if (timeline.reduce((total, clip) => total + clip.durationMs, 0) !== targetDurationMs) throw new Error('Storyboard planner cannot satisfy the requested target duration');
  let manifest: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', projectId: input.projectId, seed: input.seed, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline, audio: { ...(input.voiceAssetId ? { voiceAssetId: input.voiceAssetId } : {}), ...(input.voicePath ? { voicePath: input.voicePath } : {}), volume: 1 }, metadata: { storyboardRevisionId: input.storyboardRevisionId }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } };
  validateEditManifest(manifest); return { manifest, decisions };
}

function remainingForTarget(targetDurationMs: number, timeline: EditManifestV0['timeline']): number {
  return Math.max(1, targetDurationMs - timeline.reduce((total, clip) => total + clip.durationMs, 0));
}

function validateAndReturn(manifest: EditManifestV0): EditManifestV0 { validateEditManifest(manifest); return manifest; }
