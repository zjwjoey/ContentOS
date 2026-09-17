import { validateEditManifest, type ClipMatchingV1, type EditManifestV0 } from '../../../contracts/src/index.js';
import { segmentScriptSentences, type ScriptSentence } from './sentence-segmenter.js';

export interface PlannerAsset { id: string; storageKey: string; sourcePath: string; durationMs: number; usageCount?: number; lastUsedAt?: string; recentUsageCount?: number; }
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

export interface SentenceMontageAsset extends StoryboardPlannerAsset { usageCount?: number; lastUsedAt?: string; recentUsageCount?: number; }
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
export interface BrandingAsset extends PlannerAsset { role: 'INTRO' | 'OUTRO'; }
export interface BrandingConfig { intro?: BrandingAsset; outro?: BrandingAsset; }

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

function validVoiceTiming(sentence: TimedScriptSentence): boolean { return sentence.voiceStartMs !== undefined && sentence.voiceEndMs !== undefined && Number.isFinite(sentence.voiceStartMs) && Number.isFinite(sentence.voiceEndMs) && sentence.voiceEndMs > sentence.voiceStartMs; }
function validateVoiceTimeline(sentences: TimedScriptSentence[]): void { const timed = sentences.filter(validVoiceTiming).sort((a, b) => (a.voiceStartMs || 0) - (b.voiceStartMs || 0)); for (let index = 1; index < timed.length; index += 1) if ((timed[index]!.voiceStartMs || 0) < (timed[index - 1]!.voiceEndMs || 0)) throw new Error('Voice sentence timings overlap'); }

function assetText(asset: SentenceMontageAsset): string {
  const metadata = Object.values(asset.metadata || {}).flatMap((value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : []);
  return [asset.originalName || '', ...(asset.tags || []), ...metadata].join(' ');
}

function boundedAssetClip(asset: SentenceMontageAsset, requestedDurationMs: number, random: () => number): { durationMs: number; sourceInMs: number } | null {
  if (requestedDurationMs > Math.floor(asset.durationMs)) return null;
  const durationMs = Math.max(1, requestedDurationMs);
  const maxIn = Math.max(0, Math.floor(asset.durationMs) - durationMs);
  return { durationMs, sourceInMs: maxIn > 0 ? Math.floor(random() * (maxIn + 1)) : 0 };
}

function usagePenalty(asset: SentenceMontageAsset): number {
  const usageCount = asset.usageCount ?? Number(asset.metadata?.usageCount || 0);
  const recentUsageCount = asset.recentUsageCount ?? Number(asset.metadata?.recentUsageCount || 0);
  const lastUsedAt = asset.lastUsedAt || (typeof asset.metadata?.lastUsedAt === 'string' ? asset.metadata.lastUsedAt : undefined);
  const historical = Math.log2(Math.max(0, usageCount) + 1) * 2;
  const recent = Math.log2(Math.max(0, recentUsageCount) + 1) * 3;
  const lastUsed = lastUsedAt ? Math.max(0, Date.now() - Date.parse(lastUsedAt)) : Number.POSITIVE_INFINITY;
  const recency = Number.isFinite(lastUsed) && lastUsed < 30 * 24 * 60 * 60 * 1000 ? 3 : 0;
  return historical + recent + recency;
}

function visualTiming(sentences: TimedScriptSentence[], sentence: TimedScriptSentence, index: number, cursor: number): { startMs: number; endMs: number } {
  const startMs = validVoiceTiming(sentence) ? sentence.voiceStartMs! : cursor;
  const endMs = validVoiceTiming(sentence) ? sentence.voiceEndMs! : startMs + sentenceDurationMs(sentence, 1, Number.MAX_SAFE_INTEGER);
  const next = sentences[index + 1];
  return { startMs, endMs: next && validVoiceTiming(next) && next.voiceStartMs! > endMs ? next.voiceStartMs! : endMs };
}

function sentenceManifest(input: SentenceMontageBaseInput, sentences: TimedScriptSentence[], mode: 'SCRIPT' | 'RANDOM', decisions: SentenceMontageDecision[], timeline: EditManifestV0['timeline']): EditManifestV0 {
  validateVoiceTimeline(sentences);
  const owner = ownerOf(input); const manifest: EditManifestV0 = {
    schemaVersion: 'EDIT_MANIFEST_V0', ...owner, seed: input.seed,
    canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline,
    audio: { ...(input.voiceAssetId ? { voiceAssetId: input.voiceAssetId } : {}), ...(input.voicePath ? { voicePath: input.voicePath } : {}), volume: 1 },
    metadata: { editMode: mode, audioOffsetMs: 0, sentences: sentences.map(({ index, text, normalizedText, voiceStartMs, voiceEndMs, durationMs }) => ({ index, text, normalizedText, ...(voiceStartMs !== undefined ? { voiceStartMs } : {}), ...(voiceEndMs !== undefined ? { voiceEndMs } : {}), ...(durationMs !== undefined ? { durationMs } : {}) })) },
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
  let visualCursor = 0;
  for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
    const sentence = sentences[sentenceIndex]!;
    const required = sentenceTokens(sentence.text); const previous = timeline.at(-1)?.assetId;
    const requestedDuration = sentenceDurationMs(sentence, minMs, maxMs);
    const ranked = assets.map((asset) => { const available = sentenceTokens(assetText(asset)); const matchedKeywords = required.filter((token) => available.includes(token)); const matchScore = required.length ? Math.round((matchedKeywords.length / required.length) * 100) : 0; const historyPenalty = usagePenalty(asset); return { asset, matchedKeywords, matchScore, historyPenalty }; }).sort((a, b) => { const scoreDelta = b.matchScore - a.matchScore; if (Math.abs(scoreDelta) > 5) return scoreDelta; return (a.matchScore - a.historyPenalty) - (b.matchScore - b.historyPenalty) || a.asset.id.localeCompare(b.asset.id); });
    const eligible = ranked.filter((item) => item.asset.id !== previous && item.asset.durationMs >= requestedDuration);
    const selected = (eligible[0] || ranked.find((item) => item.asset.durationMs >= requestedDuration) || ranked[0]);
    if (!selected || selected.asset.durationMs < requestedDuration) throw new Error(`第${sentence.index + 1}句话需要${(requestedDuration / 1000).toFixed(1)}秒画面，但当前素材都不足${(requestedDuration / 1000).toFixed(1)}秒。`);
    const timing = boundedAssetClip(selected.asset, requestedDuration, random); if (!timing) throw new Error(`第${sentence.index + 1}句话需要足够长的画面素材。`); const fallback = selected.matchScore === 0;
    const sceneId = `scene-${String(sentence.index + 1).padStart(3, '0')}`;
    const matching: ClipMatchingV1 = { matchedKeywords: selected.matchedKeywords, matchScore: selected.matchScore, fallback, matchingReason: fallback ? '未找到关键词匹配，已使用规则兜底素材' : `命中关键词：${selected.matchedKeywords.join('、')}` };
    const placement = visualTiming(sentences, sentence, sentenceIndex, visualCursor); visualCursor = placement.endMs;
    timeline.push({ assetId: selected.asset.id, sourcePath: selected.asset.sourcePath, sourceInMs: timing.sourceInMs, durationMs: timing.durationMs, timelineStartMs: placement.startMs, timelineEndMs: placement.endMs, transition: timeline.length ? 'cut' : 'cut', sentenceIndex: sentence.index, sentenceText: sentence.text, sceneId, matching, role: 'CONTENT', reviewStatus: fallback || selected.matchScore < 30 ? 'REVIEW' : 'GOOD', ...(validVoiceTiming(sentence) ? { voiceStartMs: sentence.voiceStartMs, voiceEndMs: sentence.voiceEndMs } : {}) });
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
  let visualCursor = 0;
  for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
    const sentence = sentences[sentenceIndex]!; const previous = timeline.at(-1)?.assetId; const requestedDuration = sentenceDurationMs(sentence, minMs, maxMs);
    const eligible = assets.filter((asset) => asset.durationMs >= requestedDuration); if (eligible.length === 0) throw new Error(`第${sentence.index + 1}句话需要${(requestedDuration / 1000).toFixed(1)}秒画面，但当前素材都不足${(requestedDuration / 1000).toFixed(1)}秒。`);
    const ranked = eligible.map((asset) => ({ asset, score: usage.get(asset.id)! * 8 + usagePenalty(asset) })).sort((a, b) => a.score - b.score || a.asset.id.localeCompare(b.asset.id)); const lowest = ranked[0]!.score; const pool = ranked.filter((item) => item.score <= lowest + 1 && (eligible.length === 1 || item.asset.id !== previous)); const selected = (pool[Math.floor(random() * pool.length)]?.asset || ranked.find((item) => item.asset.id !== previous)?.asset || ranked[0]!.asset); const timing = boundedAssetClip(selected, requestedDuration, random)!; const sceneId = `scene-${String(sentence.index + 1).padStart(3, '0')}`; const fallback = eligible.length === 1 && previous === selected.id; const matching: ClipMatchingV1 = { matchedKeywords: [], matchScore: 0, fallback, matchingReason: fallback ? '素材不足，允许重复使用同一素材' : '优先选择近期较少使用的素材' };
    const placement = visualTiming(sentences, sentence, sentenceIndex, visualCursor); visualCursor = placement.endMs;
    usage.set(selected.id, (usage.get(selected.id) || 0) + 1); timeline.push({ assetId: selected.id, sourcePath: selected.sourcePath, sourceInMs: timing.sourceInMs, durationMs: timing.durationMs, timelineStartMs: placement.startMs, timelineEndMs: placement.endMs, transition: 'cut', sentenceIndex: sentence.index, sentenceText: sentence.text, sceneId, matching, role: 'CONTENT', reviewStatus: fallback ? 'REVIEW' : 'GOOD', ...(validVoiceTiming(sentence) ? { voiceStartMs: sentence.voiceStartMs, voiceEndMs: sentence.voiceEndMs } : {}) }); decisions.push({ sentenceIndex: sentence.index, sceneId, assetId: selected.id, durationMs: timing.durationMs, ...matching });
  }
  return { manifest: sentenceManifest(input, sentences, 'RANDOM', decisions, timeline), decisions, sentences };
}

export const buildRandomSentenceManifest = buildRandomSentenceMontageManifest;
export const buildScriptManifest = buildScriptMontageManifest;

/** Assemble fixed branding clips around CONTENT clips before persistence/render. */
export function assembleBrandedTimeline(manifest: EditManifestV0, branding: BrandingConfig): EditManifestV0 {
  if (!branding.intro && !branding.outro) return manifest;
  const maxBrandingMs = 10_000;
  const intro = branding.intro ? { ...branding.intro, durationMs: Math.min(maxBrandingMs, Math.floor(branding.intro.durationMs)) } : null;
  const outro = branding.outro ? { ...branding.outro, durationMs: Math.min(maxBrandingMs, Math.floor(branding.outro.durationMs)) } : null;
  if (intro && intro.durationMs <= 0) throw new Error('Intro duration must be positive');
  if (outro && outro.durationMs <= 0) throw new Error('Outro duration must be positive');
  const content = manifest.timeline.map((clip) => ({ ...clip, role: clip.role || 'CONTENT' as const }));
  const timeline: EditManifestV0['timeline'] = [
    ...(intro ? [{ assetId: intro.id, sourcePath: intro.sourcePath, sourceInMs: 0, durationMs: intro.durationMs, transition: 'cut' as const, role: 'INTRO' as const, reviewStatus: 'GOOD' as const }] : []),
    ...content,
    ...(outro ? [{ assetId: outro.id, sourcePath: outro.sourcePath, sourceInMs: 0, durationMs: outro.durationMs, transition: 'cut' as const, role: 'OUTRO' as const, reviewStatus: 'GOOD' as const }] : []),
  ];
  const offset = intro?.durationMs || 0;
  const shiftedTimeline = timeline.map((clip, index) => ({ ...clip, ...(clip.timelineStartMs !== undefined ? { timelineStartMs: clip.timelineStartMs + offset, timelineEndMs: (clip.timelineEndMs || clip.timelineStartMs + clip.durationMs) + offset } : index > 0 && timeline[index - 1]?.timelineEndMs !== undefined ? { timelineStartMs: (timeline[index - 1]!.timelineEndMs || 0) + offset, timelineEndMs: (timeline[index - 1]!.timelineEndMs || 0) + offset + clip.durationMs } : {}) }));
  return validateAndReturn({ ...manifest, timeline: shiftedTimeline, metadata: { ...(manifest.metadata || {}), audioOffsetMs: offset }, ...(manifest.subtitles ? { subtitles: manifest.subtitles.map((subtitle) => ({ ...subtitle, startMs: subtitle.startMs + offset, endMs: subtitle.endMs + offset })) } : {}) });
}
