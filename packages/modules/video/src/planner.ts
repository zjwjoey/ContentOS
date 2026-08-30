import {
  validateEditManifest,
  validateStoryboardSceneAssetBindingsV1,
  type EditManifestV0,
  type StoryboardSceneAssetBindingV1,
  type StoryboardSceneV1,
} from '../../../contracts/src/index.js';

export interface PlannerAsset {
  id: string;
  storageKey: string;
  sourcePath: string;
  durationMs: number;
}
export interface BuildManifestInput {
  projectId?: string;
  workspaceId?: string;
  seed: number;
  assets: PlannerAsset[];
  targetDurationMs: number;
  voiceAssetId?: string;
  voicePath?: string;
  subtitleText?: string;
  metadata?: EditManifestV0['metadata'];
}

function ownerOf(input: { projectId?: string; workspaceId?: string }): { projectId: string } | { workspaceId: string } {
  if (input.projectId !== undefined) return { projectId: input.projectId };
  if (input.workspaceId !== undefined) return { workspaceId: input.workspaceId };
  throw new Error('Video planner requires exactly one projectId or workspaceId');
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function seededShuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

export function buildVideoManifest(input: BuildManifestInput): EditManifestV0 {
  if (input.assets.length === 0) throw new Error('Video planner requires at least one video asset');
  if (!Number.isInteger(input.targetDurationMs) || input.targetDurationMs <= 0) throw new Error('targetDurationMs must be positive');
  const owner = ownerOf(input);
  const random = seededRandom(input.seed);
  const shuffled = seededShuffle(input.assets, random);
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
    schemaVersion: 'EDIT_MANIFEST_V0',
    ...owner,
    seed: input.seed,
    canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 },
    timeline,
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

export interface StoryboardPlannerInput {
  projectId: string;
  seed: number;
  scenes: ReadonlyArray<Pick<StoryboardSceneV1, 'sceneIndex' | 'durationHintSeconds'>>;
  sceneAssetBindings: ReadonlyArray<StoryboardSceneAssetBindingV1>;
  assets: ReadonlyArray<PlannerAsset>;
  voiceAssetId?: string;
  voicePath?: string;
  metadata?: Omit<NonNullable<EditManifestV0['metadata']>, 'plannerMode'>;
}

/** Deterministic, source-rotating planner used by Standalone Quick Edit. */
export function buildRandomMontageManifest(input: RandomMontageInput): EditManifestV0 {
  const minClipDurationMs = input.minClipDurationMs ?? 2_000;
  const maxClipDurationMs = input.maxClipDurationMs ?? 5_000;
  if (!Number.isInteger(minClipDurationMs) || minClipDurationMs <= 0 || !Number.isInteger(maxClipDurationMs) || maxClipDurationMs < minClipDurationMs)
    throw new Error('Random Montage clip bounds are invalid');
  if (input.assets.length === 0) throw new Error('Random Montage requires at least one video asset');
  if (input.assets.some((asset) => !Number.isFinite(asset.durationMs) || asset.durationMs <= 0))
    throw new Error('Random Montage requires every video asset to have a positive duration');
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
    const durationMs =
      remaining <= maxClipDurationMs && remaining <= availableMs ? remaining : minDurationMs + Math.floor(random() * (maxDurationMs - minDurationMs + 1));
    if (durationMs <= 0) throw new Error('Random Montage generated an invalid clip duration');
    const maxIn = Math.max(0, asset.durationMs - durationMs);
    const sourceInMs = maxIn === 0 ? 0 : Math.floor(random() * (maxIn + 1));
    timeline.push({ assetId: asset.id, sourcePath: asset.sourcePath, sourceInMs, durationMs, transition: timeline.length ? 'cut' : 'cut' });
    usage.set(asset.id, (usage.get(asset.id) || 0) + 1);
    remaining -= durationMs;
  }
  return validateAndReturn({
    schemaVersion: 'EDIT_MANIFEST_V0',
    ...owner,
    seed: input.seed,
    canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 },
    timeline,
    audio: { ...(input.voiceAssetId ? { voiceAssetId: input.voiceAssetId } : {}), ...(input.voicePath ? { voicePath: input.voicePath } : {}), volume: 1 },
    output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' },
  });
}

/** Build a deterministic project plan from explicit Storyboard scene bindings. */
export function buildStoryboardManifest(input: StoryboardPlannerInput): EditManifestV0 {
  if (!input.projectId.trim()) throw new Error('Storyboard planner requires a projectId');
  if (!Number.isInteger(input.seed)) throw new Error('Storyboard planner seed must be an integer');
  if (!Array.isArray(input.scenes) || input.scenes.length === 0) throw new Error('Storyboard planner requires at least one scene');
  validateStoryboardSceneAssetBindingsV1(input.sceneAssetBindings);
  const sceneIndexes = new Set(input.scenes.map((scene) => scene.sceneIndex));
  if (sceneIndexes.size !== input.scenes.length || input.scenes.some((scene) => !Number.isInteger(scene.sceneIndex) || scene.sceneIndex <= 0))
    throw new Error('Storyboard planner scene indexes must be unique and positive');
  if (input.sceneAssetBindings.some((binding) => !sceneIndexes.has(binding.sceneIndex)))
    throw new Error('Storyboard planner contains a binding for an unknown scene');
  const bindingsByScene = new Map(input.sceneAssetBindings.map((binding) => [binding.sceneIndex, binding]));
  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]));
  const random = seededRandom(input.seed);
  const timeline: EditManifestV0['timeline'] = [];

  for (const scene of [...input.scenes].sort((a, b) => a.sceneIndex - b.sceneIndex)) {
    if (!Number.isFinite(scene.durationHintSeconds) || scene.durationHintSeconds <= 0)
      throw new Error(`Storyboard scene ${scene.sceneIndex} has an invalid duration`);
    const sceneDurationMs = Math.round(scene.durationHintSeconds * 1000);
    const binding = bindingsByScene.get(scene.sceneIndex);
    if (!binding) throw new Error(`STORYBOARD_SCENE_ASSET_BINDING_MISSING: sceneIndex=${scene.sceneIndex}`);
    const boundAssets = binding.assetIds.map((assetId) => assetsById.get(assetId)).filter((asset): asset is PlannerAsset => Boolean(asset));
    if (boundAssets.length !== binding.assetIds.length) throw new Error(`STORYBOARD_SCENE_ASSET_INVALID: sceneIndex=${scene.sceneIndex}`);
    if (boundAssets.some((asset) => !Number.isFinite(asset.durationMs) || asset.durationMs <= 0))
      throw new Error(`STORYBOARD_SCENE_SOURCE_INSUFFICIENT: sceneIndex=${scene.sceneIndex}`);
    let remaining = sceneDurationMs;
    let cursor = Math.floor(random() * boundAssets.length);
    while (remaining > 0) {
      const previous = timeline.at(-1)?.assetId;
      const alternatives = boundAssets.filter((asset) => asset.id !== previous);
      const pool = alternatives.length > 0 ? alternatives : boundAssets;
      const asset = pool[cursor % pool.length]!;
      cursor += 1;
      const availableMs = Math.max(1, Math.floor(asset.durationMs));
      const maxDurationMs = Math.min(remaining, 5_000, availableMs);
      if (maxDurationMs <= 0) throw new Error(`STORYBOARD_SCENE_SOURCE_INSUFFICIENT: sceneIndex=${scene.sceneIndex}`);
      const minDurationMs = Math.min(2_000, maxDurationMs);
      const durationMs =
        remaining <= 5_000 && remaining <= availableMs ? remaining : minDurationMs + Math.floor(random() * (maxDurationMs - minDurationMs + 1));
      const maxIn = Math.max(0, availableMs - durationMs);
      const sourceInMs = maxIn === 0 ? 0 : Math.floor(random() * (maxIn + 1));
      timeline.push({ assetId: asset.id, sourcePath: asset.sourcePath, sourceInMs, durationMs, transition: 'cut', sceneIndex: scene.sceneIndex });
      remaining -= durationMs;
    }
    const actualSceneDuration = timeline.filter((clip) => clip.sceneIndex === scene.sceneIndex).reduce((total, clip) => total + clip.durationMs, 0);
    if (actualSceneDuration !== sceneDurationMs) throw new Error(`STORYBOARD_SCENE_DURATION_MISMATCH: sceneIndex=${scene.sceneIndex}`);
  }

  return validateAndReturn({
    schemaVersion: 'EDIT_MANIFEST_V0',
    projectId: input.projectId,
    seed: input.seed,
    canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 },
    timeline,
    audio: { ...(input.voiceAssetId ? { voiceAssetId: input.voiceAssetId } : {}), ...(input.voicePath ? { voicePath: input.voicePath } : {}), volume: 1 },
    metadata: { ...(input.metadata || {}), plannerMode: 'STORYBOARD_V1' },
    output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' },
  });
}

function validateAndReturn(manifest: EditManifestV0): EditManifestV0 {
  validateEditManifest(manifest);
  return manifest;
}
