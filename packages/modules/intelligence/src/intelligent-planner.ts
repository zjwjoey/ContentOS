import { randomUUID } from 'node:crypto';
import { validateEditManifest, validateIntelligentPlannerConfigV1, type EditManifestV0, type IntelligentEditCandidateV1, type IntelligentEditPlanV1, type IntelligentEditQualityV1, type IntelligentPlannerConfigV1 } from '../../../contracts/src/index.js';

export interface IntelligentPlannerSentence { id: string; text: string; durationMs?: number; }
export interface IntelligentPlannerAsset { id: string; sourcePath: string; durationMs: number; summary?: string; tags?: string[]; qualityScore?: number; shotId?: string | null; }
export interface IntelligentPlannerInput { id: string; projectId: string; seed?: number; sentences: IntelligentPlannerSentence[]; assets: IntelligentPlannerAsset[]; config: IntelligentPlannerConfigV1; }
export interface IntelligentPlannerResult extends Omit<IntelligentEditPlanV1, 'createdAt'> { createdAt: string; }

function tokens(value: string): Set<string> { return new Set(value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)); }
function semanticScore(sentence: string, asset: IntelligentPlannerAsset): { score: number; matched: string[] } { const wanted = tokens(sentence); const haystack = tokens(`${asset.summary || ''} ${(asset.tags || []).join(' ')}`); const matched = [...wanted].filter((token) => haystack.has(token)); return { score: wanted.size ? matched.length / wanted.size : 0, matched }; }

function defaultConfig(config: IntelligentPlannerConfigV1): IntelligentPlannerConfigV1 { validateIntelligentPlannerConfigV1(config); return config; }

export function evaluateIntelligentManifest(manifest: EditManifestV0, config: IntelligentPlannerConfigV1): IntelligentEditQualityV1 {
  const total = manifest.timeline.reduce((sum, clip) => sum + clip.durationMs, 0);
  const counts = new Map<string, number>(); let adjacentDuplicateCount = 0;
  for (const [index, clip] of manifest.timeline.entries()) { counts.set(clip.assetId, (counts.get(clip.assetId) || 0) + 1); if (index > 0 && manifest.timeline[index - 1]?.assetId === clip.assetId && !clip.matching?.allowAssetReuse) adjacentDuplicateCount += 1; }
  const repeated = manifest.timeline.length ? manifest.timeline.filter((clip) => (counts.get(clip.assetId) || 0) > 1).length / manifest.timeline.length : 1;
  const coverage = config.targetDurationMs ? Math.min(1, total / config.targetDurationMs) : 0;
  const issues = [ ...(coverage < 1 ? ['TARGET_DURATION_NOT_COVERED'] : []), ...(adjacentDuplicateCount > 0 ? ['ADJACENT_DUPLICATE_ASSET'] : []), ...(repeated > 0.75 && manifest.timeline.length > 1 ? ['HIGH_ASSET_REPETITION'] : []) ];
  return { coverage, distinctAssetCount: counts.size, repeatedAssetRatio: repeated, adjacentDuplicateCount, passed: issues.length === 0, issues };
}

export function planIntelligentEdit(input: IntelligentPlannerInput): IntelligentPlannerResult {
  const config = defaultConfig(input.config);
  if (!input.sentences.length || !input.assets.length) throw new Error('INTELLIGENT_PLANNER_INPUT_EMPTY');
  const candidates: IntelligentEditCandidateV1[] = []; const timeline: EditManifestV0['timeline'] = []; const useCounts = new Map<string, number>();
  for (const [sentenceIndex, sentence] of input.sentences.entries()) {
    const ranked = input.assets.map((asset) => {
      const semantic = semanticScore(sentence.text, asset); const duration = Math.max(0, 1 - Math.abs((sentence.durationMs || config.minClipDurationMs) - Math.min(asset.durationMs, config.maxClipDurationMs)) / Math.max(config.maxClipDurationMs, 1)); const quality = Math.max(0, Math.min(1, asset.qualityScore ?? 0.5)); const reuse = useCounts.get(asset.id) || 0; const diversity = reuse === 0 ? 1 : Math.max(0, 1 - reuse / config.maxAssetReuse); const repetition = reuse >= config.maxAssetReuse ? 0 : 1; const score = semantic.score * 0.45 + duration * 0.2 + quality * 0.15 + diversity * config.diversityWeight * 0.2 + repetition * 0.1; return { asset, semantic, duration, quality, diversity, repetition, reuse, score }; }).sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));
    const previous = timeline.at(-1)?.assetId; const selected = ranked.find((item) => item.asset.id !== previous && item.reuse < config.maxAssetReuse) || ranked[0]!;
    const durationMs = Math.min(config.maxClipDurationMs, Math.max(config.minClipDurationMs, sentence.durationMs || config.minClipDurationMs), selected.asset.durationMs);
    const allowReuse = selected.asset.id === previous || selected.reuse >= config.maxAssetReuse;
    timeline.push({ assetId: selected.asset.id, sourcePath: selected.asset.sourcePath, sourceInMs: 0, sourceOutMs: durationMs, durationMs, transition: timeline.length ? 'cut' : 'cut', sentenceIndex, sentenceId: sentence.id, sentenceText: sentence.text, matching: { matchedKeywords: selected.semantic.matched, matchScore: Math.round(selected.semantic.score * 100), fallback: selected.semantic.score === 0, matchingReason: selected.semantic.score > 0 ? `语义命中：${selected.semantic.matched.join('、')}` : '无直接语义命中，按时长/多样性/质量回退', reason: selected.semantic.score > 0 ? 'SEMANTIC_MATCH' : 'DIVERSITY_DURATION_FALLBACK', ...(allowReuse ? { allowAssetReuse: true } : {}) }, role: 'CONTENT', reviewStatus: 'REVIEW', selectionSource: 'AUTO', revision: 1 });
    useCounts.set(selected.asset.id, selected.reuse + 1);
    for (const item of ranked.slice(0, 3)) candidates.push({ id: `candidate-${input.id}-${sentence.id}-${item.asset.id}`, sentenceId: sentence.id, assetId: item.asset.id, shotId: item.asset.shotId || null, score: item.score, selected: item.asset.id === selected.asset.id, reasons: [ ...(item.semantic.matched.length ? [`semantic:${item.semantic.matched.join('|')}`] : ['semantic:none']), `duration:${item.duration.toFixed(3)}`, `quality:${item.quality.toFixed(3)}`, `diversity:${item.diversity.toFixed(3)}` ], features: { semantic: item.semantic.score, duration: item.duration, quality: item.quality, diversity: item.diversity, repetition: item.repetition } });
  }
  const manifest: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', projectId: input.projectId, seed: input.seed || 1, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline, audio: { volume: 1 }, metadata: { editMode: 'SCRIPT', plannerVersion: config.version, sentences: input.sentences.map((sentence, index) => ({ index, text: sentence.text, normalizedText: sentence.text })) }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } };
  validateEditManifest(manifest);
  const quality = evaluateIntelligentManifest(manifest, config);
  return { schemaVersion: 'INTELLIGENT_EDIT_PLAN_V1', id: input.id, projectId: input.projectId, config, manifest, candidates, quality, createdAt: new Date().toISOString() };
}
