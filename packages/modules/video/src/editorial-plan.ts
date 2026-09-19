import { createHash } from 'node:crypto';
import { calculateSentenceRequiredDurationMs, type TimedScriptSentence } from './planner.js';
import type { EditManifestV0, ManifestClip } from '../../../contracts/src/index.js';
import { DEFAULT_PRESENTATION_SETTINGS_V1, normalizePresentationSettings, type PresentationSettingsV1 } from '../../../contracts/src/index.js';
import { applyPresentationSettings } from './presentation-compiler.js';

export type EditorialTemplateV1 = 'COMMERCIAL_OPINION' | 'NEWS' | 'STORE_PROMOTION' | 'PRODUCT_INTRO';
export type EditorialPaceV1 = 'SLOW' | 'NORMAL' | 'FAST';
export type EditorialShotDensityV1 = 'LOW' | 'MEDIUM' | 'HIGH';
export type NarrativeRoleV1 = 'HOOK' | 'BODY' | 'EXPLANATION' | 'TURN' | 'AUTHENTIC_ENTITY' | 'EVIDENCE' | 'CTA' | 'ENDING';
export type EditorialSourcePolicyV1 = 'AUTO' | 'LOCAL_ONLY' | 'PREFER_LOCAL' | 'PREFER' | 'MUST_USE';

export interface EditorialTemplateConfigV1 {
  id: EditorialTemplateV1; version: string; templateName: string; pace: EditorialPaceV1; shotDensity: EditorialShotDensityV1;
  subtitleStyle: 'simple' | 'commercial' | 'emphasis' | 'news'; heroTextEnabled: boolean; heroTextPolicy: Array<'HOOK' | 'ENDING' | 'EVIDENCE'>;
  backgroundMusicMode: 'NONE' | 'AUTO'; backgroundMusicCategory?: string; backgroundMusicVolume: number; duckingEnabled: boolean;
  introEnabled: boolean; outroEnabled: boolean; assetReusePolicy: 'PREFER_UNIQUE' | 'STRICT_UNIQUE'; pexelsEnabledDefault: boolean;
}
export const EDITORIAL_TEMPLATES: Record<EditorialTemplateV1, EditorialTemplateConfigV1> = {
  COMMERCIAL_OPINION: { id: 'COMMERCIAL_OPINION', version: '1.0.0', templateName: '商业观点', pace: 'NORMAL', shotDensity: 'MEDIUM', subtitleStyle: 'commercial', heroTextEnabled: true, heroTextPolicy: ['HOOK', 'ENDING'], backgroundMusicMode: 'AUTO', backgroundMusicCategory: '商务', backgroundMusicVolume: 0.12, duckingEnabled: true, introEnabled: false, outroEnabled: false, assetReusePolicy: 'PREFER_UNIQUE', pexelsEnabledDefault: true },
  NEWS: { id: 'NEWS', version: '1.0.0', templateName: '新闻解读', pace: 'FAST', shotDensity: 'HIGH', subtitleStyle: 'news', heroTextEnabled: true, heroTextPolicy: ['HOOK', 'ENDING', 'EVIDENCE'], backgroundMusicMode: 'AUTO', backgroundMusicCategory: '新闻', backgroundMusicVolume: 0.1, duckingEnabled: true, introEnabled: false, outroEnabled: false, assetReusePolicy: 'PREFER_UNIQUE', pexelsEnabledDefault: true },
  STORE_PROMOTION: { id: 'STORE_PROMOTION', version: '1.0.0', templateName: '门店宣传', pace: 'FAST', shotDensity: 'HIGH', subtitleStyle: 'commercial', heroTextEnabled: true, heroTextPolicy: ['HOOK', 'ENDING'], backgroundMusicMode: 'AUTO', backgroundMusicCategory: '轻快', backgroundMusicVolume: 0.14, duckingEnabled: true, introEnabled: true, outroEnabled: true, assetReusePolicy: 'PREFER_UNIQUE', pexelsEnabledDefault: true },
  PRODUCT_INTRO: { id: 'PRODUCT_INTRO', version: '1.0.0', templateName: '产品介绍', pace: 'NORMAL', shotDensity: 'MEDIUM', subtitleStyle: 'emphasis', heroTextEnabled: true, heroTextPolicy: ['HOOK', 'EVIDENCE', 'ENDING'], backgroundMusicMode: 'AUTO', backgroundMusicCategory: '科技', backgroundMusicVolume: 0.12, duckingEnabled: true, introEnabled: false, outroEnabled: false, assetReusePolicy: 'PREFER_UNIQUE', pexelsEnabledDefault: true },
};

export interface EditorialAssetV1 { id: string; path: string; durationMs: number; source: 'LOCAL' | 'PEXELS' | 'FAKE_PEXELS'; entity?: string; keywords?: string[]; originalName?: string; tags?: string[]; sourceInMs?: number; author?: string; thumbnailUrl?: string; }
export interface PriorityAssetV1 { assetId: string; mode: 'PREFER' | 'MUST_USE'; path?: string; }
export interface ClipSlotV1 {
  id: string; sceneId: string; index: number; clipIndex?: number; startMs: number; endMs: number; durationMs: number; keywords: string[]; role: NarrativeRoleV1; visualIntent: string;
  sourcePolicy: EditorialSourcePolicyV1; entityRequirement?: string; assetReusePolicy: 'PREFER_UNIQUE' | 'STRICT_UNIQUE' | 'CONTROLLED_REUSE'; locked?: boolean;
  selectedAssetId?: string; selectedSource?: EditorialAssetV1['source']; prioritySource?: 'NORMAL' | 'PREFER' | 'MUST_USE'; entityFallback?: boolean; reason?: string; asset?: EditorialAssetV1;
}
export interface ScenePlanV1 {
  id: string; sceneIndex: number; sentenceIndex: number; sourceSentenceIndexes: number[]; text: string; startMs: number; endMs: number; durationMs: number;
  role: NarrativeRoleV1; narrativeRole?: NarrativeRoleV1; sceneType: 'HOOK' | 'CONTENT' | 'EVIDENCE' | 'CTA' | 'ENDING'; visualIntent: string; clipCount: number; clipSlots: ClipSlotV1[];
  textOverlay?: NonNullable<EditManifestV0['textOverlays']>[number]; assetPolicy: EditorialSourcePolicyV1; locked?: boolean; reason?: string;
}
export interface SubtitlePlanV1 { style: 'simple' | 'commercial' | 'emphasis' | 'news'; cues: NonNullable<EditManifestV0['subtitles']>; keywords: string[]; }
export interface EditorialAudioPlanV1 { backgroundMusicMode: 'NONE' | 'AUTO' | 'SPECIFIED'; category?: string; volume: number; duckingEnabled: boolean; path?: string; }
export interface EditorialBrandingPlanV1 { introEnabled: boolean; outroEnabled: boolean; brandingPresetId?: string; }
export interface EditorialPlanV1 {
  schemaVersion: 'EDITORIAL_PLAN_V1'; plannerVersion: string; scriptHash: string; templateId: EditorialTemplateV1; templateVersion: string; template?: EditorialTemplateV1;
  pace: EditorialPaceV1; shotDensity: EditorialShotDensityV1 | number; totalDurationMs: number; sentences: TimedScriptSentence[]; scenes: ScenePlanV1[];
  subtitlePlan: SubtitlePlanV1; audioPlan: EditorialAudioPlanV1; brandingPlan: EditorialBrandingPlanV1; subtitles: NonNullable<EditManifestV0['subtitles']>; textOverlays: NonNullable<EditManifestV0['textOverlays']>; presentationSettings?: PresentationSettingsV1; warnings?: string[];
}
export type ResolvedEditorialPlanV1 = Omit<EditorialPlanV1, 'schemaVersion'> & { schemaVersion: 'RESOLVED_EDITORIAL_PLAN_V1'; resolvedAt?: string };
export interface EditorialPlanInput {
  sentences: TimedScriptSentence[]; template?: EditorialTemplateV1; pace?: EditorialPaceV1; shotDensity?: EditorialShotDensityV1 | number; subtitleStyle?: EditorialTemplateConfigV1['subtitleStyle']; heroText?: boolean;
  heroTextPolicy?: Array<'HOOK' | 'ENDING' | 'EVIDENCE'>; knownEntities?: string[]; manualKeywords?: string[]; audioPlan?: Partial<EditorialAudioPlanV1>; brandingPlan?: Partial<EditorialBrandingPlanV1>;
  presentationSettings?: PresentationSettingsV1;
  oneClipPerSegment?: boolean;
}
export interface EditorialResolveOptions { priorityAssets?: PriorityAssetV1[]; localOnly?: boolean; allowControlledReuse?: boolean; strictUnique?: boolean; seed?: number; excludeAssetIds?: string[]; }

const turn = /(但是|不过|然而|问题是)/u; const explanation = /(实际上|所以)/u; const evidence = /(例如|比如|数据显示|销售额|门店数|\d+(?:\.\d+)?\s*%|[%€$])/iu; const cta = /(欢迎|关注|评论|联系我们|到店|期待|te esperamos)/iu;
const densityNumber: Record<EditorialShotDensityV1, number> = { LOW: 0.75, MEDIUM: 1, HIGH: 1.35 }; const paceTarget: Record<EditorialPaceV1, number> = { SLOW: 5_000, NORMAL: 3_250, FAST: 2_200 };
function scriptHash(sentences: TimedScriptSentence[]): string { return createHash('sha256').update(sentences.map((sentence) => `${sentence.index}:${sentence.text}:${sentence.voiceStartMs ?? ''}:${sentence.voiceEndMs ?? ''}`).join('|')).digest('hex'); }
function normalizedTerms(text: string): string[] { return [...new Set(text.normalize('NFKC').toLocaleLowerCase().split(/\s+/u).flatMap((part) => { const compact = part.replace(/[。！？!?，,；;：:]/gu, ''); if (compact.length < 2) return [compact]; return [compact, ...[...compact].slice(0, Math.min(8, compact.length - 1))]; }).filter(Boolean))]; }
function knownEntity(text: string, entities: string[]): string | undefined { return entities.find((entity) => entity.trim() && text.toLocaleLowerCase().includes(entity.toLocaleLowerCase())); }
function classifyRole(sentence: TimedScriptSentence, index: number, total: number, known: string[]): NarrativeRoleV1 { if (index === 0) return 'HOOK'; if (index === total - 1) return 'ENDING'; if (knownEntity(sentence.text, known)) return 'AUTHENTIC_ENTITY'; if (turn.test(sentence.text)) return 'TURN'; if (explanation.test(sentence.text)) return 'EXPLANATION'; if (evidence.test(sentence.text)) return 'EVIDENCE'; if (cta.test(sentence.text)) return 'CTA'; return 'BODY'; }
function visualIntent(role: NarrativeRoleV1, template: EditorialTemplateV1): string { if (role === 'AUTHENTIC_ENTITY') return 'authentic entity / brand / store'; if (role === 'EVIDENCE') return template === 'NEWS' ? 'evidence / data / chart context' : 'evidence / product detail'; if (role === 'CTA') return 'people / contact / invitation'; if (role === 'HOOK') return 'attention / brand context'; if (role === 'ENDING') return 'closing / place / brand memory'; if (role === 'TURN' || role === 'EXPLANATION') return 'context / meeting / transition'; return template === 'PRODUCT_INTRO' ? 'product detail / usage scene' : 'neutral b-roll'; }
function sceneType(role: NarrativeRoleV1): ScenePlanV1['sceneType'] { return role === 'HOOK' ? 'HOOK' : role === 'ENDING' ? 'ENDING' : role === 'EVIDENCE' ? 'EVIDENCE' : role === 'CTA' ? 'CTA' : 'CONTENT'; }
function countFor(durationMs: number, pace: EditorialPaceV1, density: number, role: NarrativeRoleV1): number { let count = Math.ceil(durationMs / (paceTarget[pace] / Math.max(0.5, density))); if (role === 'HOOK') count += 1; if (role === 'AUTHENTIC_ENTITY' || role === 'ENDING' || role === 'EXPLANATION') count -= 1; if (role === 'EVIDENCE') count = Math.min(count, 2); return Math.max(1, Math.min(3, count)); }
function splitDuration(total: number, count: number): number[] { const base = Math.floor(total / count); const rest = total - base * count; return Array.from({ length: count }, (_, index) => base + (index < rest ? 1 : 0)); }
function wrapSubtitleText(text: string, maxChars = 14, maxLines = 2): string { const compact = text.replace(/\s+/gu, ' ').trim(); if (!compact) return compact; const parts: string[] = []; let buffer = ''; for (const char of [...compact]) { if (buffer.length >= maxChars && /[\s，。！？!?；;,:：]/u.test(char)) { parts.push(buffer.trim()); buffer = ''; } else if (buffer.length >= maxChars) { parts.push(buffer); buffer = ''; } buffer += char; } if (buffer) parts.push(buffer.trim()); return parts.slice(0, maxLines).join('\n'); }
function styleCue(text: string, startMs: number, endMs: number, style: EditorialTemplateConfigV1['subtitleStyle'], presentation?: PresentationSettingsV1): NonNullable<EditManifestV0['subtitles']>[number] {
  const fontSize = presentation?.subtitleStyle.fontSize ?? (style === 'emphasis' ? 60 : 48);
  const maxChars = presentation ? Math.max(8, Math.floor((presentation.canvas.width * presentation.subtitleStyle.maxWidth) / Math.max(1, fontSize * .9))) : 14;
  return { text: wrapSubtitleText(text, maxChars, presentation?.subtitleStyle.maxLines ?? 2), startMs, endMs, style: style === 'news' ? 'commercial' : style, fontSize, position: 'bottom', maxLines: presentation?.subtitleStyle.maxLines ?? 2, outline: presentation?.subtitleStyle.outline.enabled ?? true, background: presentation?.subtitleStyle.background.enabled ?? style !== 'simple' };
}
function styleHero(text: string, startMs: number, endMs: number, kind: 'HERO' | 'EVIDENCE'): NonNullable<EditManifestV0['textOverlays']>[number] { return { text: wrapSubtitleText(text, 12, 3), startMs, endMs, kind, style: 'emphasis', fontSize: kind === 'EVIDENCE' ? 56 : 64, position: 'center' }; }
export function getEditorialTemplateConfig(template: EditorialTemplateV1): EditorialTemplateConfigV1 { return { ...EDITORIAL_TEMPLATES[template] }; }

export function planEditorialScript(input: EditorialPlanInput): EditorialPlanV1 {
  const templateId = input.template ?? 'COMMERCIAL_OPINION'; const config = EDITORIAL_TEMPLATES[templateId]; const pace = input.pace ?? config.pace; const density = typeof input.shotDensity === 'number' ? Math.max(0.5, Math.min(2, input.shotDensity)) : densityNumber[input.shotDensity ?? config.shotDensity]; const shotDensity = input.shotDensity ?? config.shotDensity; let cursor = 0;
  const scenes = input.sentences.map((sentence, index) => {
    const voiced = sentence.voiceStartMs !== undefined && sentence.voiceEndMs !== undefined && sentence.voiceEndMs > sentence.voiceStartMs; const durationMs = Math.max(1, Math.round(voiced ? sentence.voiceEndMs! - sentence.voiceStartMs! : calculateSentenceRequiredDurationMs(sentence, 1_500, 12_000))); const startMs = sentence.voiceStartMs ?? cursor; const endMs = sentence.voiceEndMs ?? startMs + durationMs; cursor = endMs; const role = classifyRole(sentence, index, input.sentences.length, input.knownEntities ?? []); const count = input.oneClipPerSegment ? 1 : countFor(durationMs, pace, density, role); const durations = splitDuration(durationMs, count); let local = startMs; const policy: EditorialSourcePolicyV1 = role === 'AUTHENTIC_ENTITY' ? 'PREFER_LOCAL' : 'AUTO'; const reuse = role === 'AUTHENTIC_ENTITY' ? 'CONTROLLED_REUSE' : config.assetReusePolicy;
    const slots = durations.map((slotDuration, slotIndex) => { const slot: ClipSlotV1 = { id: `scene-${index + 1}-clip-${slotIndex + 1}`, sceneId: `scene-${index + 1}`, index: slotIndex, clipIndex: slotIndex, startMs: local, endMs: local + slotDuration, durationMs: slotDuration, keywords: [...new Set([...normalizedTerms(sentence.normalizedText || sentence.text), ...(input.manualKeywords ?? [])])].slice(0, 16), role, visualIntent: visualIntent(role, templateId), sourcePolicy: policy, ...(knownEntity(sentence.text, input.knownEntities ?? []) ? { entityRequirement: knownEntity(sentence.text, input.knownEntities ?? [])! } : {}), assetReusePolicy: reuse, reason: role === 'HOOK' ? '开头场景采用较高镜头密度' : role === 'AUTHENTIC_ENTITY' ? '检测到真实主体，优先本地真实素材' : '按模板规则生成镜头' }; local += slotDuration; return slot; });
    const heroEnabled = input.heroText !== false && (input.heroTextPolicy ?? config.heroTextPolicy).includes(role as 'HOOK' | 'ENDING' | 'EVIDENCE'); const overlay = heroEnabled ? styleHero(sentence.text, startMs, endMs, role === 'EVIDENCE' ? 'EVIDENCE' : 'HERO') : undefined;
    return { id: `scene-${index + 1}`, sceneIndex: index, sentenceIndex: sentence.index, sourceSentenceIndexes: [sentence.index], text: sentence.text, startMs, endMs, durationMs, role, narrativeRole: role, sceneType: sceneType(role), visualIntent: visualIntent(role, templateId), clipCount: slots.length, clipSlots: slots, ...(overlay ? { textOverlay: overlay } : {}), assetPolicy: policy, ...(slots[0]?.reason ? { reason: slots[0].reason } : {}) };
  });
  const subtitleStyle = input.subtitleStyle ?? config.subtitleStyle; const presentation = input.presentationSettings ? normalizePresentationSettings(input.presentationSettings) : undefined; const cues = scenes.map((scene) => styleCue(scene.text, scene.startMs, scene.endMs, subtitleStyle, presentation)); const textOverlays = scenes.flatMap((scene) => scene.textOverlay ? [scene.textOverlay] : []); const totalDurationMs = scenes.reduce((max, scene) => Math.max(max, scene.endMs), 0);
  return { schemaVersion: 'EDITORIAL_PLAN_V1', plannerVersion: '1.0.0', scriptHash: scriptHash(input.sentences), templateId, templateVersion: config.version, template: templateId, pace, shotDensity, totalDurationMs, sentences: input.sentences, scenes, subtitlePlan: { style: subtitleStyle, cues, keywords: [...new Set([...input.manualKeywords ?? [], ...input.knownEntities ?? [], ...input.sentences.flatMap((sentence) => (sentence.text.match(/\d+(?:\.\d+)?%|€\s*\d[\d.,]*/gu) ?? []))])] }, audioPlan: { backgroundMusicMode: input.audioPlan?.backgroundMusicMode ?? config.backgroundMusicMode, ...(input.audioPlan?.category || config.backgroundMusicCategory ? { category: input.audioPlan?.category ?? config.backgroundMusicCategory } : {}), volume: input.audioPlan?.volume ?? config.backgroundMusicVolume, duckingEnabled: input.audioPlan?.duckingEnabled ?? config.duckingEnabled, ...(input.audioPlan?.path ? { path: input.audioPlan.path } : {}) }, brandingPlan: { introEnabled: input.brandingPlan?.introEnabled ?? config.introEnabled, outroEnabled: input.brandingPlan?.outroEnabled ?? config.outroEnabled, ...(input.brandingPlan?.brandingPresetId ? { brandingPresetId: input.brandingPlan.brandingPresetId } : {}) }, subtitles: cues, textOverlays, ...(presentation ? { presentationSettings: presentation } : {}) };
}

function assetMatchScore(slot: ClipSlotV1, asset: EditorialAssetV1, priority: PriorityAssetV1 | undefined): number { const haystack = `${asset.id} ${asset.originalName ?? ''} ${asset.entity ?? ''} ${(asset.keywords ?? []).join(' ')} ${(asset.tags ?? []).join(' ')}`.toLocaleLowerCase(); let score = priority?.mode === 'MUST_USE' ? 120 : priority?.mode === 'PREFER' ? 90 : 0; score += slot.keywords.reduce((sum, key) => sum + (haystack.includes(key.toLocaleLowerCase()) ? 10 : 0), 0); if (slot.entityRequirement && matchesEntity(asset, slot.entityRequirement)) score += 100; if (slot.role === 'AUTHENTIC_ENTITY' && asset.source === 'LOCAL' && asset.entity) score += 50; if (slot.sourcePolicy === 'LOCAL_ONLY' && asset.source !== 'LOCAL') return -1; return score; }
function matchesEntity(asset: EditorialAssetV1, requirement: string | undefined): boolean { return Boolean(requirement && asset.entity?.trim().toLocaleLowerCase() === requirement.trim().toLocaleLowerCase()); }
function assetIdentity(asset: EditorialAssetV1): string { return asset.path.trim().normalize('NFKC').toLocaleLowerCase() || asset.id; }
export function resolveEditorialPlan(plan: EditorialPlanV1, assets: EditorialAssetV1[], seed = 1, options: EditorialResolveOptions = {}): ResolvedEditorialPlanV1 {
  const priority = new Map((options.priorityAssets ?? []).map((item) => [item.assetId, item])); const excluded = new Set(options.excludeAssetIds ?? []); const ordered = [...assets].filter((asset) => !excluded.has(asset.id)).sort((a, b) => a.id.localeCompare(b.id)); const used = new Set<string>(); let cursor = Math.abs(options.seed ?? seed) % Math.max(1, ordered.length); const controlledReuse = options.allowControlledReuse !== false && options.strictUnique !== true;
  const scenes = plan.scenes.map((scene) => ({ ...scene, clipSlots: scene.clipSlots.map((slot) => {
    if (slot.locked && slot.asset) {
      if (slot.asset.durationMs < slot.durationMs) throw new Error(`EDIT_ASSET_TOO_SHORT:${slot.asset.id}:需要${slot.durationMs}ms`);
      used.add(assetIdentity(slot.asset)); const prioritySource: ClipSlotV1['prioritySource'] = priority.get(slot.asset.id)?.mode ?? 'NORMAL'; const entityFallback = Boolean(slot.entityRequirement && !matchesEntity(slot.asset, slot.entityRequirement)); return { ...slot, selectedAssetId: slot.asset.id, selectedSource: slot.asset.source, prioritySource, entityFallback };
    }
    const candidates = ordered.filter((asset) => asset.durationMs >= slot.durationMs && (!(options.localOnly || slot.sourcePolicy === 'LOCAL_ONLY') || asset.source === 'LOCAL')).map((asset) => ({ asset, priority: priority.get(asset.id), score: assetMatchScore(slot, asset, priority.get(asset.id)) })).filter((item) => item.score >= 0).sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));
    const authenticCandidates = slot.entityRequirement ? candidates.filter((item) => matchesEntity(item.asset, slot.entityRequirement)) : [];
    const genericCandidates = slot.entityRequirement ? candidates.filter((item) => !matchesEntity(item.asset, slot.entityRequirement)) : candidates;
    const unusedAuthentic = authenticCandidates.filter((item) => !used.has(assetIdentity(item.asset)));
    const unusedGeneric = genericCandidates.filter((item) => !used.has(assetIdentity(item.asset)));
    const chosenPool = unusedAuthentic.length ? unusedAuthentic : unusedGeneric.length ? unusedGeneric : controlledReuse ? (authenticCandidates.length ? authenticCandidates : genericCandidates) : [];
    const reused = chosenPool.length > 0 && used.has(assetIdentity(chosenPool[0]!.asset));
    if (!chosenPool.length) {
      const hasAnyCandidate = ordered.some((asset) => (!(options.localOnly || slot.sourcePolicy === 'LOCAL_ONLY') || asset.source === 'LOCAL') && assetMatchScore(slot, asset, priority.get(asset.id)) >= 0);
      if (hasAnyCandidate) throw new Error(`EDIT_NO_MEDIA_LONG_ENOUGH:第${slot.sceneId}需要${slot.durationMs}ms画面，但当前素材都不足`);
      throw new Error('EDIT_UNIQUE_MEDIA_EXHAUSTED: editorial plan requires more unique assets');
    }
    const chosen = chosenPool[cursor++ % chosenPool.length]!; const isAuthentic = !slot.entityRequirement || matchesEntity(chosen.asset, slot.entityRequirement); const entityFallback = Boolean(slot.entityRequirement && !isAuthentic); used.add(assetIdentity(chosen.asset)); const prioritySource: ClipSlotV1['prioritySource'] = chosen.priority?.mode ?? 'NORMAL'; const reason = prioritySource === 'MUST_USE' ? '该素材由用户标记为必须出现' : prioritySource === 'PREFER' ? '该素材由用户标记为优先素材' : reused ? '可用素材已用尽，按规则受控复用' : entityFallback ? '没有真实主体素材，已使用中性补画' : slot.reason; return { ...slot, asset: chosen.asset, selectedAssetId: chosen.asset.id, selectedSource: chosen.asset.source, prioritySource, entityFallback, assetReusePolicy: reused ? 'CONTROLLED_REUSE' : slot.assetReusePolicy, ...(reason ? { reason } : {}) };
  }) }));
  const mustUse = [...priority.entries()].filter(([, value]) => value.mode === 'MUST_USE').map(([id]) => id); const selected = new Set(scenes.flatMap((scene) => scene.clipSlots.flatMap((slot) => slot.selectedAssetId ? [slot.selectedAssetId] : []))); const missing = mustUse.filter((id) => !selected.has(id)); if (missing.length) { const tooShort = missing.filter((id) => { const asset = assets.find((candidate) => candidate.id === id); return asset && plan.scenes.some((scene) => scene.clipSlots.some((slot) => slot.durationMs > asset.durationMs)); }); if (tooShort.length) throw new Error(`EDIT_PRIORITY_ASSET_TOO_SHORT:${tooShort.join(',')}`); throw new Error(`EDIT_MUST_USE_ASSET_UNSATISFIED:${missing.join(',')}`); }
  return { ...plan, schemaVersion: 'RESOLVED_EDITORIAL_PLAN_V1', resolvedAt: new Date(0).toISOString(), scenes };
}
export function rerollEditorialClip(plan: ResolvedEditorialPlanV1, assets: EditorialAssetV1[], clipId: string, options: EditorialResolveOptions = {}): ResolvedEditorialPlanV1 {
  const target = plan.scenes.flatMap((scene) => scene.clipSlots).find((slot) => slot.id === clipId);
  if (!target) throw new Error('SCRIPT_CLIP_NOT_FOUND');
  if (target.locked) throw new Error('SCRIPT_CLIP_LOCKED');
  const originalLocks = new Map(plan.scenes.flatMap((scene) => scene.clipSlots.map((slot) => [slot.id, slot.locked] as const)));
  const rerollInput: EditorialPlanV1 = { ...plan, schemaVersion: 'EDITORIAL_PLAN_V1', scenes: plan.scenes.map((scene) => ({ ...scene, clipSlots: scene.clipSlots.map((slot) => {
    if (slot.id !== clipId) return { ...slot, locked: true };
    const { asset: _asset, selectedAssetId: _selectedAssetId, selectedSource: _selectedSource, ...withoutSelection } = slot;
    return { ...withoutSelection, locked: false };
  }) })) };
  const resolved = resolveEditorialPlan(rerollInput, assets, options.seed ?? 1, { ...options, excludeAssetIds: [...(options.excludeAssetIds ?? []), ...(target.selectedAssetId ? [target.selectedAssetId] : [])] });
  return { ...resolved, scenes: resolved.scenes.map((scene) => ({ ...scene, clipSlots: scene.clipSlots.map((slot) => { const originalLock = originalLocks.get(slot.id); return originalLock === undefined ? slot : { ...slot, locked: originalLock }; }) })) };
}

export function compileEditorialManifest(plan: ResolvedEditorialPlanV1, input: { workspaceId?: string; projectId?: string; seed: number; voiceAssetId?: string; voicePath?: string; backgroundMusic?: EditManifestV0['audio']['backgroundMusic']; fps?: number; planId?: string; revision?: number; intro?: EditorialAssetV1; outro?: EditorialAssetV1; presentationSettings?: PresentationSettingsV1; }): EditManifestV0 {
  const timeline: ManifestClip[] = []; const orderedScenes = [...plan.scenes].sort((a, b) => a.sceneIndex - b.sceneIndex); const contentOffsetMs = input.intro ? Math.min(input.intro.durationMs, 1_500) : 0; let timelineCursor = 0;
  const addClip = (asset: EditorialAssetV1, durationMs: number, role: NonNullable<ManifestClip['role']>, scene?: ScenePlanV1, slot?: ClipSlotV1, startMs?: number, endMs?: number): void => {
    const timelineStartMs = startMs ?? timelineCursor; const timelineEndMs = endMs ?? timelineStartMs + durationMs; const matchingReason = slot?.reason ?? 'rule-based editorial plan'; const authentic = Boolean(slot?.entityRequirement && matchesEntity(asset, slot.entityRequirement));
    timeline.push({ assetId: asset.id, sourcePath: asset.path, sourceInMs: slot?.asset?.sourceInMs ?? asset.sourceInMs ?? 0, durationMs, transition: 'cut', ...(scene ? { sentenceIndex: scene.sentenceIndex, sentenceText: scene.text, sceneId: scene.id, voiceStartMs: scene.startMs + contentOffsetMs, voiceEndMs: scene.endMs + contentOffsetMs, role } : { role }), timelineStartMs, timelineEndMs, ...(slot?.selectedSource ? { matching: { matchedKeywords: slot.keywords, matchScore: slot.entityFallback ? 0 : authentic ? 100 : 60, fallback: Boolean(slot.entityFallback), matchingReason, allowAssetReuse: slot.assetReusePolicy === 'CONTROLLED_REUSE', selectedSource: slot.selectedSource, selectedRole: authentic ? 'AUTHENTIC_ENTITY' : slot.entityRequirement ? (slot.visualIntent.includes('place') ? 'PLACE_CONTEXT' : 'NEUTRAL_BROLL') : 'GENERIC_BROLL', entityFallback: Boolean(slot.entityFallback), reason: matchingReason } } : {}) }); timelineCursor = Math.max(timelineCursor, timelineEndMs);
  };
  if (input.intro) addClip(input.intro, contentOffsetMs, 'INTRO', undefined, undefined, 0, contentOffsetMs);
  for (const scene of orderedScenes) for (const slot of scene.clipSlots) { if (!slot.asset) throw new Error(`Unresolved editorial clip ${slot.id}`); addClip(slot.asset, slot.durationMs, 'CONTENT', scene, slot, scene.startMs + contentOffsetMs + (slot.startMs - scene.startMs), scene.startMs + contentOffsetMs + (slot.endMs - scene.startMs)); }
  if (input.outro) { const duration = Math.min(input.outro.durationMs, 1_500); addClip(input.outro, duration, 'OUTRO', undefined, undefined, timelineCursor, timelineCursor + duration); }
  const subtitles = plan.subtitles.map((cue) => ({ ...cue, startMs: cue.startMs + contentOffsetMs, endMs: cue.endMs + contentOffsetMs })); const textOverlays = plan.textOverlays.map((overlay) => ({ ...overlay, startMs: overlay.startMs + contentOffsetMs, endMs: overlay.endMs + contentOffsetMs }));
  const sentences = plan.sentences.map((sentence) => ({ ...sentence, ...(sentence.voiceStartMs !== undefined ? { voiceStartMs: sentence.voiceStartMs + contentOffsetMs } : {}), ...(sentence.voiceEndMs !== undefined ? { voiceEndMs: sentence.voiceEndMs + contentOffsetMs } : {}) }));
  const presentation = normalizePresentationSettings(input.presentationSettings ?? plan.presentationSettings ?? DEFAULT_PRESENTATION_SETTINGS_V1);
  const metadata: EditManifestV0['metadata'] = { editMode: 'SCRIPT', sentences, audioOffsetMs: contentOffsetMs, presentationSettings: presentation, ...(input.planId ? { editorialPlanId: input.planId } : {}), ...(input.revision !== undefined ? { editorialRevision: input.revision } : {}), templateId: plan.templateId, plannerVersion: plan.plannerVersion, ...(plan.warnings?.length ? { warnings: plan.warnings } : {}) };
  const planMusic = plan.audioPlan.path ? { path: plan.audioPlan.path, volume: plan.audioPlan.volume, loop: true, ...(plan.audioPlan.category ? { category: plan.audioPlan.category } : {}), ducking: { enabled: plan.audioPlan.duckingEnabled, musicVolume: plan.audioPlan.volume } } : undefined;
  const backgroundMusic: NonNullable<EditManifestV0['audio']['backgroundMusic']> | undefined = input.backgroundMusic ?? planMusic;
  const manifest: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), seed: input.seed, canvas: presentation.canvas, timeline, audio: { ...(input.voiceAssetId ? { voiceAssetId: input.voiceAssetId } : {}), ...(input.voicePath ? { voicePath: input.voicePath } : {}), ...(backgroundMusic ? { backgroundMusic } : {}), volume: 1 }, subtitles, subtitleStyle: presentation.subtitleStyle, presentationSettings: presentation, textOverlays, metadata, output: presentation.output };
  return applyPresentationSettings(manifest, presentation);
}
