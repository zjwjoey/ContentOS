import { validateEditManifest, validateIntelligentPlannerConfigV1, type EditManifestV0, type IntelligentEditCandidateV1, type IntelligentEditPlanV1, type IntelligentEditQualityV1, type IntelligentPlannerConfigV1 } from '../../../contracts/src/index.js';

export interface IntelligentPlannerSentence { id: string; text: string; durationMs?: number; embedding?: number[]; }
export interface IntelligentPlannerShot {
  id: string;
  assetId: string;
  shotId: string;
  sourcePath: string;
  sourceInMs: number;
  sourceOutMs: number;
  durationMs: number;
  summary?: string;
  tags?: string[];
  transcript?: string;
  qualityScore?: number;
  shotType?: string;
  cameraMotion?: string;
  embedding?: number[];
}
/** Legacy asset input remains supported for callers that have not migrated to shot data yet. */
export interface IntelligentPlannerAsset extends Omit<IntelligentPlannerShot, 'id' | 'assetId' | 'shotId' | 'sourceInMs' | 'sourceOutMs'> { id: string; assetId?: string; shotId?: string | null; sourceInMs?: number; sourceOutMs?: number; }
export interface IntelligentPlannerInput { id: string; projectId: string; seed?: number; sentences: IntelligentPlannerSentence[]; assets?: IntelligentPlannerAsset[]; shots?: IntelligentPlannerShot[]; config: IntelligentPlannerConfigV1; analysisVersion?: string; sourceAnalysisRunIds?: string[]; }
export interface IntelligentPlannerResult extends Omit<IntelligentEditPlanV1, 'createdAt'> { createdAt: string; }

function tokens(value: string): Set<string> {
  const words = value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const word of [...words]) if (/^[\u3400-\u9fff]+$/u.test(word)) for (let size = 2; size <= Math.min(4, word.length); size += 1) for (let start = 0; start + size <= word.length; start += 1) words.push(word.slice(start, start + size));
  return new Set(words);
}
function cosine(left: number[], right: number[]): number { if (!left.length || left.length !== right.length) return 0; let dot = 0; let leftNorm = 0; let rightNorm = 0; for (let index = 0; index < left.length; index += 1) { dot += left[index]! * right[index]!; leftNorm += left[index]! ** 2; rightNorm += right[index]! ** 2; } if (!leftNorm || !rightNorm) return 0; return Math.max(0, Math.min(1, (dot / Math.sqrt(leftNorm * rightNorm) + 1) / 2)); }
function semanticScore(sentence: IntelligentPlannerSentence, shot: IntelligentPlannerShot): { score: number; matched: string[]; vectorScore: number } { const wanted = tokens(sentence.text); const haystack = tokens(`${shot.summary || ''} ${(shot.tags || []).join(' ')} ${shot.transcript || ''}`); const matched = [...wanted].filter((token) => haystack.has(token)); const lexicalScore = wanted.size ? matched.length / wanted.size : 0; const vectorScore = sentence.embedding && shot.embedding ? cosine(sentence.embedding, shot.embedding) : 0; return { score: sentence.embedding && shot.embedding ? vectorScore * 0.7 + lexicalScore * 0.3 : lexicalScore, matched, vectorScore }; }
function defaultConfig(config: IntelligentPlannerConfigV1): IntelligentPlannerConfigV1 { validateIntelligentPlannerConfigV1(config); return config; }

export function evaluateIntelligentManifest(manifest: EditManifestV0, config: IntelligentPlannerConfigV1): IntelligentEditQualityV1 {
  const total = manifest.timeline.reduce((sum, clip) => sum + clip.durationMs, 0);
  const counts = new Map<string, number>(); const shotCounts = new Map<string, number>(); const shotTypes = new Set<string>(); let adjacentDuplicateCount = 0; let consecutiveSameAssetCount = 0; let semanticTotal = 0; let durationTotal = 0;
  for (const [index, clip] of manifest.timeline.entries()) {
    counts.set(clip.assetId, (counts.get(clip.assetId) || 0) + 1);
    if (clip.sourceSegmentId) shotCounts.set(clip.sourceSegmentId, (shotCounts.get(clip.sourceSegmentId) || 0) + 1);
    if (clip.matching?.selectedRole) shotTypes.add(clip.matching.selectedRole);
    if (clip.matching) semanticTotal += Math.max(0, Math.min(1, clip.matching.matchScore / 100));
    durationTotal += config.maxClipDurationMs > 0 ? Math.max(0, Math.min(1, clip.durationMs / config.maxClipDurationMs)) : 0;
    if (index > 0 && manifest.timeline[index - 1]?.assetId === clip.assetId && !clip.matching?.allowAssetReuse) { adjacentDuplicateCount += 1; consecutiveSameAssetCount += 1; }
  }
  const repeated = manifest.timeline.length ? manifest.timeline.filter((clip) => (counts.get(clip.assetId) || 0) > 1).length / manifest.timeline.length : 1;
  const repeatedShots = manifest.timeline.length ? manifest.timeline.filter((clip) => clip.sourceSegmentId && (shotCounts.get(clip.sourceSegmentId) || 0) > 1).length / manifest.timeline.length : 1;
  const coverage = config.targetDurationMs ? Math.min(1, total / config.targetDurationMs) : 0;
  const semanticMatch = manifest.timeline.length ? semanticTotal / manifest.timeline.length : 0;
  const durationFit = manifest.timeline.length ? durationTotal / manifest.timeline.length : 0;
  const shotTypeDiversity = manifest.timeline.length ? Math.min(1, shotTypes.size / Math.min(manifest.timeline.length, 3)) : 0;
  const issues = [ ...(coverage < 1 ? ['TARGET_DURATION_NOT_COVERED'] : []), ...(semanticMatch < 0.25 ? ['LOW_SEMANTIC_MATCH'] : []), ...(durationFit < 0.5 ? ['LOW_DURATION_FIT'] : []), ...(adjacentDuplicateCount > 0 ? ['ADJACENT_DUPLICATE_ASSET'] : []), ...(repeated > 0.75 && manifest.timeline.length > 1 ? ['HIGH_ASSET_REPETITION'] : []), ...(repeatedShots > 0.5 && manifest.timeline.length > 1 ? ['HIGH_SHOT_REPETITION'] : []), ...(shotTypeDiversity < 0.5 && manifest.timeline.length > 1 ? ['LOW_SHOT_TYPE_DIVERSITY'] : []) ];
  return { coverage, distinctAssetCount: counts.size, repeatedAssetRatio: repeated, adjacentDuplicateCount, semanticMatch, durationFit, repeatedShotRatio: repeatedShots, shotTypeDiversity, consecutiveSameAssetCount, passed: issues.length === 0, issues };
}

export function planIntelligentEdit(input: IntelligentPlannerInput): IntelligentPlannerResult {
  const config = defaultConfig(input.config);
  const pool: IntelligentPlannerShot[] = input.shots?.length ? input.shots : (input.assets || []).map((asset) => ({ id: asset.id, assetId: asset.assetId || asset.id, shotId: asset.shotId || `asset-shot-${asset.id}`, sourcePath: asset.sourcePath, sourceInMs: asset.sourceInMs ?? 0, sourceOutMs: asset.sourceOutMs ?? asset.durationMs, durationMs: Math.max(1, asset.sourceOutMs ? asset.sourceOutMs - (asset.sourceInMs || 0) : asset.durationMs), ...(asset.summary ? { summary: asset.summary } : {}), ...(asset.tags ? { tags: asset.tags } : {}), ...(asset.transcript ? { transcript: asset.transcript } : {}), ...(asset.qualityScore === undefined ? {} : { qualityScore: asset.qualityScore }), ...(asset.shotType ? { shotType: asset.shotType } : {}), ...(asset.cameraMotion ? { cameraMotion: asset.cameraMotion } : {}), ...(asset.embedding ? { embedding: asset.embedding } : {}) }));
  if (!input.sentences.length || !pool.length) throw new Error('INTELLIGENT_PLANNER_INPUT_EMPTY');
  const candidates: IntelligentEditCandidateV1[] = []; const timeline: EditManifestV0['timeline'] = []; const useCounts = new Map<string, number>(); const shotUseCounts = new Map<string, number>();
  for (const [sentenceIndex, sentence] of input.sentences.entries()) {
    const ranked = pool.map((shot) => {
      const semantic = semanticScore(sentence, shot); const requested = sentence.durationMs || config.minClipDurationMs; const duration = Math.max(0, 1 - Math.abs(requested - Math.min(shot.durationMs, config.maxClipDurationMs)) / Math.max(config.maxClipDurationMs, 1)); const quality = Math.max(0, Math.min(1, shot.qualityScore ?? 0.5)); const reuse = useCounts.get(shot.assetId) || 0; const shotReuse = shotUseCounts.get(shot.shotId) || 0; const diversity = reuse === 0 ? 1 : Math.max(0, 1 - reuse / config.maxAssetReuse); const repetition = reuse >= config.maxAssetReuse || shotReuse > 0 ? 0 : 1; const score = semantic.score * 0.45 + duration * 0.2 + quality * 0.15 + diversity * config.diversityWeight * 0.1 + (shotReuse === 0 ? 0.1 : 0) + repetition * 0.1; return { shot, semantic, duration, quality, diversity, repetition, reuse, shotReuse, score };
    }).sort((a, b) => b.score - a.score || a.shot.assetId.localeCompare(b.shot.assetId) || a.shot.shotId.localeCompare(b.shot.shotId));
    const previous = timeline.at(-1); const selected = ranked.find((item) => item.shot.assetId !== previous?.assetId && item.shot.shotId !== previous?.sourceSegmentId && item.reuse < config.maxAssetReuse) || ranked[0]!;
    const durationMs = Math.min(config.maxClipDurationMs, Math.max(1, Math.max(config.minClipDurationMs, sentence.durationMs || config.minClipDurationMs)), selected.shot.durationMs); const sourceInMs = selected.shot.sourceInMs; const sourceOutMs = sourceInMs + durationMs; const allowReuse = selected.shot.assetId === previous?.assetId || selected.reuse >= config.maxAssetReuse; const shotType = selected.shot.shotType || 'unknown';
    timeline.push({ assetId: selected.shot.assetId, sourcePath: selected.shot.sourcePath, sourceInMs, sourceOutMs, durationMs, transition: 'cut', sourceSegmentId: selected.shot.shotId, sentenceIndex, sentenceId: sentence.id, sentenceText: sentence.text, matching: { matchedKeywords: selected.semantic.matched, matchScore: Math.round(selected.semantic.score * 100), fallback: selected.semantic.score === 0, matchingReason: selected.semantic.score > 0 ? `语义命中：${selected.semantic.matched.join('、') || '向量相似'}` : '无直接语义命中，按时长/多样性/质量回退', reason: selected.semantic.score > 0 ? 'SEMANTIC_MATCH' : 'DIVERSITY_DURATION_FALLBACK', selectedRole: shotType === 'unknown' ? 'GENERIC_BROLL' : 'AUTHENTIC_ENTITY', ...(allowReuse ? { allowAssetReuse: true } : {}) }, role: 'CONTENT', reviewStatus: 'REVIEW', selectionSource: 'AUTO', revision: 1 });
    useCounts.set(selected.shot.assetId, selected.reuse + 1); shotUseCounts.set(selected.shot.shotId, selected.shotReuse + 1);
    for (const item of ranked.slice(0, 3)) candidates.push({ id: `candidate-${input.id}-${sentence.id}-${item.shot.shotId}`, sentenceId: sentence.id, assetId: item.shot.assetId, shotId: item.shot.shotId, sourceInMs: item.shot.sourceInMs, sourceOutMs: item.shot.sourceOutMs, score: item.score, selected: item.shot.shotId === selected.shot.shotId, reasons: [ ...(item.semantic.matched.length ? [`semantic:${item.semantic.matched.join('|')}`] : item.semantic.vectorScore > 0 ? [`semantic-vector:${item.semantic.vectorScore.toFixed(3)}`] : ['semantic:none']), `duration:${item.duration.toFixed(3)}`, `quality:${item.quality.toFixed(3)}`, `shot-diversity:${item.diversity.toFixed(3)}`, `shot-type:${item.shot.shotType || 'unknown'}` ], features: { semantic: item.semantic.score, duration: item.duration, quality: item.quality, diversity: item.diversity, repetition: item.repetition } });
  }
  const manifest: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', projectId: input.projectId, seed: input.seed || 1, canvas: { width: 1080, height: 1920, aspectRatio: '9:16', fps: 30 }, timeline, audio: { volume: 1 }, metadata: { editMode: 'SCRIPT', plannerVersion: config.version, intelligentPlanId: input.id, ...(input.analysisVersion ? { analysisVersion: input.analysisVersion } : {}), sentences: input.sentences.map((sentence, index) => ({ index, text: sentence.text, normalizedText: sentence.text })) }, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' } };
  validateEditManifest(manifest);
  const quality = evaluateIntelligentManifest(manifest, config);
  return { schemaVersion: 'INTELLIGENT_EDIT_PLAN_V1', id: input.id, projectId: input.projectId, config, manifest, candidates, quality, sourceAnalysisRunIds: [...new Set(input.sourceAnalysisRunIds || [])], plannerVersion: config.version, analysisVersion: input.analysisVersion || null, manifestId: null, videoRevisionId: null, createdAt: new Date().toISOString() };
}
