import { validateEditManifest, type ClipMatchingV1, type EditManifestV0 } from '../../../contracts/src/index.js';
import { segmentScriptSentences, type ScriptSentence } from './sentence-segmenter.js';

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

export interface TimedScriptSentence extends ScriptSentence {
  /** Optional sentence-level voice timing. When present it wins over estimation. */
  voiceStartMs?: number;
  voiceEndMs?: number;
  durationMs?: number;
}

export interface SentenceMontageAsset extends StoryboardPlannerAsset {}
export interface SentenceMontageBaseInput {
  projectId?: string;
  workspaceId?: string;
  seed: number;
  sentences: TimedScriptSentence[];
  assets: SentenceMontageAsset[];
  voiceAssetId?: string;
  voicePath?: string;
  minClipDurationMs?: number;
  maxClipDurationMs?: number;
  splitSemicolon?: boolean;
}
export interface SentenceMontageDecision {
  sentenceIndex: number;
  sceneId: string;
  assetId: string;
  durationMs: number;
  matchedKeywords: string[];
  matchScore: number;
  fallback: boolean;
  matchingReason: string;
}
export interface SentenceMontageResult { manifest: EditManifestV0; decisions: SentenceMontageDecision[]; sentences: TimedScriptSentence[]; }

export interface ScriptMontageInput extends SentenceMontageBaseInput {
  script?: string;
}

export interface RandomSentenceMontageInput extends SentenceMontageBaseInput {}

function sentenceTokens(value: string): string[] {
  const terms = value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).map((item) => item.trim()).filter((item) => item.length >= 1);
  // Chinese has no whitespace boundaries. Keep complete runs and add short
  // n-grams so tags such as “门店” can explainably match “欧洲门店正在扩张”.
  for (const term of [...terms]) {
    if (!/^[\u3400-\u9fff]+$/u.test(term) || term.length < 2) continue;
    for (let size = 2; size <= Math.min(4, term.length); size += 1) for (let start = 0; start + size <= term.length; start += 1) terms.push(term.slice(start, start + size));
  }
  return [...new Set(terms)];
}

function normalizeSentences(input: SentenceMontageBaseInput, script?: string): TimedScriptSentence[] {
  const provided: TimedScriptSentence[] = input.sentences.length > 0 ? input.sentences : script ? segmentScriptSentences(script, ...(input.splitSemicolon === undefined ? [] : [{ splitSemicolon: input.splitSemicolon }])) : [];
  return provided.map((sentence, index) => ({ index, text: sentence.text.trim(), normalizedText: sentence.normalizedText?.trim() || sentence.text.normalize('NFKC').toLowerCase().trim(), ...(sentence.voiceStartMs !== undefined ? { voiceStartMs: sentence.voiceStartMs } : {}), ...(sentence.voiceEndMs !== undefined ? { voiceEndMs: sentence.voiceEndMs } : {}), ...(sentence.durationMs !== undefined ? { durationMs: sentence.durationMs } : {}) })).filter((sentence) => sentence.text.length > 0);
}

function sentenceDurationMs(sentence: TimedScriptSentence, minMs: number, maxMs: number): number {
  const voiced = sentence.voiceStartMs !== undefined && sentence.voiceEndMs !== undefined ? sentence.voiceEndMs - sentence.voiceStartMs : undefined;
  const explicit = voiced !== undefined && voiced > 0 ? voiced : sentence.durationMs;
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  const units = [...sentence.text.replace(/\s+/gu, '')].length;
  return Math.max(minMs, Math.min(maxMs, Math.round(Math.max(1, units) * 260)));
}

function assetText(asset: SentenceMontageAsset): string {
  const metadata = Object.values(asset.metadata || {}).flatMap((value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : []);
  return [asset.originalName || '', ...(asset.tags || []), ...metadata].join(' ');
}

function boundedAssetClip(asset: SentenceMontageAsset, requestedDurationMs: number, random: () => number): { durationMs: number; sourceInMs: number } {
  const durationMs = Math.max(1, Math.min(Math.floor(asset.durationMs), requestedDurationMs));
  const maxIn = Math.max(0, Math.floor(asset.durationMs) - durationMs);
  return { durationMs, sourceInMs: maxIn > 0 ? Math.floor(random() * (maxIn + 1)) : 0 };
}

function sentenceManifest(input: SentenceMontageBaseInput, sentences: TimedScriptSentence[], mode: 'SCRIPT' | 'RANDOM', decisions: SentenceMontageDecision[], timeline: EditManifestV0['timeline']): EditManifestV0 {
  const owner = ownerOf(input); const manifest: EditManifestV0 = {
    schemaVersion: 'EDIT_MANIFEST_V0', ...owner, seed: input.seed,
    canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline,
    audio: { ...(input.voiceAssetId ? { voiceAssetId: input.voiceAssetId } : {}), ...(input.voicePath ? { voicePath: input.voicePath } : {}), volume: 1 },
    metadata: { editMode: mode, sentences: sentences.map(({ index, text, normalizedText }) => ({ index, text, normalizedText })) },
    output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' },
  };
  // A one-asset library is a valid fallback case for sentence montage. V0's
  // legacy duplicate guard remains strict for manifests without editMode.
  validateEditManifest(manifest); return manifest;
}

/** Rule-based Sentence → Scene → Clip planner for script-led editing. */
export function buildScriptMontageManifest(input: ScriptMontageInput): SentenceMontageResult {
  const sentences = normalizeSentences(input, input.script); if (sentences.length === 0) throw new Error('Script montage requires at least one sentence');
  if (input.assets.length === 0) throw new Error('Script montage requires at least one video asset');
  if (input.assets.some((asset) => !Number.isFinite(asset.durationMs) || asset.durationMs <= 0)) throw new Error('Script montage requires every video asset to have a positive duration');
  const minMs = input.minClipDurationMs ?? 2_000; const maxMs = input.maxClipDurationMs ?? 5_000;
  if (!Number.isInteger(minMs) || !Number.isInteger(maxMs) || minMs <= 0 || maxMs < minMs) throw new Error('Script montage clip bounds are invalid');
  const random = seededRandom(input.seed); const assets = [...input.assets].sort((a, b) => a.id.localeCompare(b.id)); const timeline: EditManifestV0['timeline'] = []; const decisions: SentenceMontageDecision[] = [];
  for (const sentence of sentences) {
    const required = sentenceTokens(sentence.text); const previous = timeline.at(-1)?.assetId;
    const ranked = assets.map((asset) => { const available = sentenceTokens(assetText(asset)); const matchedKeywords = required.filter((token) => available.includes(token)); const matchScore = required.length ? Math.round((matchedKeywords.length / required.length) * 100) : 0; return { asset, matchedKeywords, matchScore }; }).sort((a, b) => b.matchScore - a.matchScore || a.asset.id.localeCompare(b.asset.id));
    const nonAdjacent = ranked.filter((item) => item.asset.id !== previous); const selected = (nonAdjacent[0] || ranked[0])!; const timing = boundedAssetClip(selected.asset, sentenceDurationMs(sentence, minMs, maxMs), random); const fallback = selected.matchScore === 0;
    const sceneId = `scene-${String(sentence.index + 1).padStart(3, '0')}`;
    const matching: ClipMatchingV1 = { matchedKeywords: selected.matchedKeywords, matchScore: selected.matchScore, fallback, matchingReason: fallback ? '未找到关键词匹配，已使用规则兜底素材' : `命中关键词：${selected.matchedKeywords.join('、')}` };
    timeline.push({ assetId: selected.asset.id, sourcePath: selected.asset.sourcePath, sourceInMs: timing.sourceInMs, durationMs: timing.durationMs, transition: timeline.length ? 'cut' : 'cut', sentenceIndex: sentence.index, sentenceText: sentence.text, sceneId, matching });
    decisions.push({ sentenceIndex: sentence.index, sceneId, assetId: selected.asset.id, durationMs: timing.durationMs, ...matching });
  }
  return { manifest: sentenceManifest(input, sentences, 'SCRIPT', decisions, timeline), decisions, sentences };
}

/** Deterministic Sentence → Scene → Clip planner for random montage. */
export function buildRandomSentenceMontageManifest(input: RandomSentenceMontageInput): SentenceMontageResult {
  const sentences = normalizeSentences(input); if (sentences.length === 0) throw new Error('Random montage requires at least one sentence');
  if (input.assets.length === 0) throw new Error('Random montage requires at least one video asset');
  if (input.assets.some((asset) => !Number.isFinite(asset.durationMs) || asset.durationMs <= 0)) throw new Error('Random montage requires every video asset to have a positive duration');
  const minMs = input.minClipDurationMs ?? 2_000; const maxMs = input.maxClipDurationMs ?? 5_000;
  if (!Number.isInteger(minMs) || !Number.isInteger(maxMs) || minMs <= 0 || maxMs < minMs) throw new Error('Random montage clip bounds are invalid');
  const random = seededRandom(input.seed); const assets = [...input.assets].sort((a, b) => a.id.localeCompare(b.id)); const usage = new Map(assets.map((asset) => [asset.id, 0])); const timeline: EditManifestV0['timeline'] = []; const decisions: SentenceMontageDecision[] = [];
  for (const sentence of sentences) {
    const previous = timeline.at(-1)?.assetId; const lowest = Math.min(...assets.map((asset) => usage.get(asset.id) || 0)); const pool = assets.filter((asset) => (usage.get(asset.id) || 0) === lowest && (assets.length === 1 || asset.id !== previous)); const selected = pool[Math.floor(random() * pool.length)] || assets[0]!; const timing = boundedAssetClip(selected, sentenceDurationMs(sentence, minMs, maxMs), random); const sceneId = `scene-${String(sentence.index + 1).padStart(3, '0')}`; const fallback = assets.length === 1 && previous === selected.id; const matching: ClipMatchingV1 = { matchedKeywords: [], matchScore: 0, fallback, matchingReason: fallback ? '素材不足，允许重复使用同一素材' : '按随机种子选择素材' };
    usage.set(selected.id, (usage.get(selected.id) || 0) + 1); timeline.push({ assetId: selected.id, sourcePath: selected.sourcePath, sourceInMs: timing.sourceInMs, durationMs: timing.durationMs, transition: 'cut', sentenceIndex: sentence.index, sentenceText: sentence.text, sceneId, matching }); decisions.push({ sentenceIndex: sentence.index, sceneId, assetId: selected.id, durationMs: timing.durationMs, ...matching });
  }
  return { manifest: sentenceManifest(input, sentences, 'RANDOM', decisions, timeline), decisions, sentences };
}

export const buildRandomSentenceManifest = buildRandomSentenceMontageManifest;
export const buildScriptManifest = buildScriptMontageManifest;
