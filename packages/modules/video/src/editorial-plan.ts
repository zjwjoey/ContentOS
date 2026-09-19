import { calculateSentenceRequiredDurationMs, type TimedScriptSentence } from './planner.js';
import type { EditManifestV0, ManifestClip } from '../../../contracts/src/index.js';

export type EditorialTemplateV1 = 'COMMERCIAL_OPINION' | 'NEWS' | 'STORE_PROMOTION' | 'PRODUCT_INTRO';
export type EditorialPaceV1 = 'SLOW' | 'NORMAL' | 'FAST';
export type NarrativeRoleV1 = 'HOOK' | 'BODY' | 'TURN' | 'EVIDENCE' | 'AUTHENTIC_ENTITY' | 'CTA' | 'ENDING';

export interface EditorialAssetV1 { id: string; path: string; durationMs: number; source: 'LOCAL' | 'PEXELS' | 'FAKE_PEXELS'; entity?: string; keywords?: string[]; }
export interface ClipSlotV1 { id: string; sceneId: string; index: number; durationMs: number; keywords: string[]; locked?: boolean; asset?: EditorialAssetV1; }
export interface ScenePlanV1 { id: string; sentenceIndex: number; text: string; role: NarrativeRoleV1; startMs: number; endMs: number; clipSlots: ClipSlotV1[]; }
export interface EditorialPlanV1 { schemaVersion: 'EDITORIAL_PLAN_V1'; template: EditorialTemplateV1; pace: EditorialPaceV1; shotDensity: number; sentences: TimedScriptSentence[]; scenes: ScenePlanV1[]; subtitles: NonNullable<EditManifestV0['subtitles']>; textOverlays: NonNullable<EditManifestV0['textOverlays']>; }
export type ResolvedEditorialPlanV1 = Omit<EditorialPlanV1, 'schemaVersion'> & { schemaVersion: 'RESOLVED_EDITORIAL_PLAN_V1' };
export interface EditorialPlanInput { sentences: TimedScriptSentence[]; template?: EditorialTemplateV1; pace?: EditorialPaceV1; shotDensity?: number; knownEntities?: string[]; heroText?: boolean; priorityAssetIds?: string[]; }

const roleWords: Array<[NarrativeRoleV1, RegExp]> = [
  ['TURN', /(但是|不过|然而|问题是|实际上|所以)/u],
  ['EVIDENCE', /(例如|比如|数据显示|销售额|门店数|%|€|\$)/iu],
  ['CTA', /(欢迎|关注|评论|联系我们|到店|期待|te esperamos)/iu],
];
const paceTarget: Record<EditorialPaceV1, number> = { SLOW: 5000, NORMAL: 3250, FAST: 2200 };

function classifyRole(sentence: TimedScriptSentence, index: number, total: number, known: string[]): NarrativeRoleV1 {
  if (index === 0) return 'HOOK';
  if (index === total - 1) return 'ENDING';
  if (known.some((entity) => entity.trim() && sentence.text.toLocaleLowerCase().includes(entity.toLocaleLowerCase()))) return 'AUTHENTIC_ENTITY';
  for (const [role, re] of roleWords) if (re.test(sentence.text)) return role;
  return 'BODY';
}

function targetCount(durationMs: number, pace: EditorialPaceV1, role: NarrativeRoleV1, density: number): number {
  let count = Math.ceil(durationMs / (paceTarget[pace] / Math.max(0.5, density)));
  if (role === 'HOOK') count += 1;
  if (role === 'AUTHENTIC_ENTITY' || role === 'ENDING') count -= 1;
  if (role === 'EVIDENCE') count = Math.min(count, 2);
  return Math.max(1, Math.min(3, count));
}

function splitDuration(total: number, count: number): number[] {
  const base = Math.floor(total / count); const rest = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < rest ? 1 : 0));
}

export function planEditorialScript(input: EditorialPlanInput): EditorialPlanV1 {
  const template = input.template ?? 'COMMERCIAL_OPINION'; const pace = input.pace ?? 'NORMAL'; const shotDensity = Math.max(0.5, Math.min(2, input.shotDensity ?? 1));
  let cursor = 0;
  const scenes: ScenePlanV1[] = input.sentences.map((sentence, index) => {
    const duration = Math.max(1, Math.round(sentence.voiceEndMs !== undefined && sentence.voiceStartMs !== undefined ? sentence.voiceEndMs - sentence.voiceStartMs : calculateSentenceRequiredDurationMs(sentence, 1500, 12000)));
    const role = classifyRole(sentence, index, input.sentences.length, input.knownEntities ?? []);
    const count = targetCount(duration, pace, role, shotDensity); const durations = splitDuration(duration, count); const sceneId = `scene-${index + 1}`;
    const clipSlots = durations.map((durationMs, clipIndex) => ({ id: `${sceneId}-clip-${clipIndex + 1}`, sceneId, index: clipIndex, durationMs, keywords: sentence.normalizedText.split(/\s+/u).filter(Boolean).slice(0, 8) }));
    const startMs = sentence.voiceStartMs ?? cursor; const endMs = sentence.voiceEndMs ?? startMs + duration; cursor = endMs;
    return { id: sceneId, sentenceIndex: sentence.index, text: sentence.text, role, startMs, endMs, clipSlots };
  });
  const subtitles = scenes.map((scene) => ({ text: scene.text, startMs: scene.startMs, endMs: scene.endMs, style: 'simple' as const, fontSize: 48, position: 'bottom' as const, maxLines: 2 }));
  const textOverlays = input.heroText === false ? [] : scenes.filter((s) => s.role === 'HOOK' || s.role === 'ENDING' || s.role === 'EVIDENCE').map((s) => ({ text: s.text, startMs: s.startMs, endMs: s.endMs, kind: (s.role === 'EVIDENCE' ? 'EVIDENCE' : 'HERO') as 'EVIDENCE' | 'HERO', style: 'emphasis' as const, fontSize: 64, position: 'center' as const }));
  return { schemaVersion: 'EDITORIAL_PLAN_V1', template, pace, shotDensity, sentences: input.sentences, scenes, subtitles, textOverlays };
}

export function resolveEditorialPlan(plan: EditorialPlanV1, assets: EditorialAssetV1[], seed = 1): ResolvedEditorialPlanV1 {
  const ordered = [...assets].sort((a, b) => a.id.localeCompare(b.id)); let cursor = Math.abs(seed) % Math.max(1, ordered.length); const used = new Set<string>();
  const scenes = plan.scenes.map((scene) => ({ ...scene, clipSlots: scene.clipSlots.map((slot) => {
    const available = ordered.filter((asset) => !used.has(asset.id));
    if (!available.length) throw new Error('EDIT_UNIQUE_MEDIA_EXHAUSTED: editorial plan requires more unique assets');
    const asset = available[cursor++ % available.length]!;
    used.add(asset.id);
    return { ...slot, asset };
  }) }));
  return { ...plan, schemaVersion: 'RESOLVED_EDITORIAL_PLAN_V1', scenes };
}

export function compileEditorialManifest(plan: ResolvedEditorialPlanV1, input: { workspaceId?: string; projectId?: string; seed: number; voiceAssetId?: string; voicePath?: string; backgroundMusic?: EditManifestV0['audio']['backgroundMusic']; fps?: number; }): EditManifestV0 {
  const timeline: ManifestClip[] = []; let timelineCursor = 0;
  for (const scene of plan.scenes) for (const slot of scene.clipSlots) { if (!slot.asset) throw new Error(`Unresolved editorial clip ${slot.id}`); timeline.push({ assetId: slot.asset.id, sourcePath: slot.asset.path, sourceInMs: 0, durationMs: slot.durationMs, transition: 'cut', sentenceIndex: scene.sentenceIndex, sentenceText: scene.text, sceneId: scene.id, timelineStartMs: timelineCursor, timelineEndMs: timelineCursor + slot.durationMs, voiceStartMs: scene.startMs, voiceEndMs: scene.endMs, role: scene.role === 'HOOK' ? 'INTRO' : scene.role === 'ENDING' ? 'OUTRO' : 'CONTENT', matching: { matchedKeywords: slot.keywords, matchScore: 100, fallback: false, matchingReason: 'rule-based editorial plan', allowAssetReuse: false, selectedSource: slot.asset.source, selectedRole: slot.asset.entity ? 'AUTHENTIC_ENTITY' : 'GENERIC_BROLL' } }); timelineCursor += slot.durationMs; }
  return { schemaVersion: 'EDIT_MANIFEST_V0', ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), seed: input.seed, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: input.fps ?? 30 }, timeline, audio: { ...(input.voiceAssetId ? { voiceAssetId: input.voiceAssetId } : {}), ...(input.voicePath ? { voicePath: input.voicePath } : {}), ...(input.backgroundMusic ? { backgroundMusic: input.backgroundMusic } : {}), volume: 1 }, subtitles: plan.subtitles, textOverlays: plan.textOverlays, metadata: { editMode: 'SCRIPT', sentences: plan.sentences }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } };
}
