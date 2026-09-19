import type { AssetService } from '../../asset/src/asset-service.js';
import type { AssetCatalogService } from '../../asset/src/asset-catalog-service.js';
import type { LocalStorageProvider } from '../../../infrastructure/storage/src/index.js';
import { assembleBrandedTimeline, buildRandomSentenceMontageManifest, buildScriptMontageManifest, type PlannerAsset, type ResolvedVisualAssignment, type TimedScriptSentence } from './planner.js';
import { segmentScriptSentences } from './sentence-segmenter.js';
import type { VideoAdjustmentService } from './quick-edit-service.js';
import type { VideoEditPreset, VideoEditPresetService } from './preset-service.js';
import type { VideoService } from './video-service.js';

export interface EditingWorkbenchPreparationDependencies {
  assetService: AssetService;
  assets: AssetCatalogService;
  quickEdit: VideoAdjustmentService;
  storage: LocalStorageProvider;
  video: VideoService;
  presets?: VideoEditPresetService;
}

export interface EditingWorkbenchPreparationInput {
  mode: 'SCRIPT' | 'MIX';
  workspaceId: string;
  script: string;
  voiceAssetId?: string;
  voicePath?: string;
  assets: PlannerAsset[];
  seed: number;
  minClipDurationMs: number;
  maxClipDurationMs: number;
  preferUnusedMedia: boolean;
  fps: number;
  templateId?: string;
  renderIdempotencySuffix?: string;
  resolvedAssignments?: ResolvedVisualAssignment[];
}

export interface EditingWorkbenchPreparationResult {
  voiceAssetId?: string;
  manifestId: string;
  renderJobId: string;
  renderJobState: string;
}

/** Distribute a voice track's measured duration across script sentences. */
export function fitSentencesToVoiceDuration(sentences: TimedScriptSentence[], totalDurationMs: number): TimedScriptSentence[] {
  if (!Number.isFinite(totalDurationMs) || totalDurationMs <= 0 || sentences.length === 0) return sentences;
  const weights = sentences.map((sentence) => Math.max(1, [...sentence.text.replace(/\s+/gu, '')].length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let assigned = 0;
  return sentences.map((sentence, index) => {
    const durationMs = index === sentences.length - 1
      ? Math.max(1, Math.round(totalDurationMs) - assigned)
      : Math.max(1, Math.round(totalDurationMs * (weights[index] || 1) / totalWeight));
    assigned += durationMs;
    return { ...sentence, durationMs };
  });
}

/**
 * Performs one durable batch item's preparation. It deliberately creates only
 * the normal VideoService VIDEO_RENDER job; rendering remains owned by the
 * existing video worker and no second FFmpeg pipeline is introduced.
 */
export async function prepareEditingWorkbenchItem(
  dependencies: EditingWorkbenchPreparationDependencies,
  input: EditingWorkbenchPreparationInput,
): Promise<EditingWorkbenchPreparationResult> {
  const preset: VideoEditPreset | null = input.templateId
    ? await dependencies.presets?.get(input.templateId) || null
    : await dependencies.presets?.getDefault() || null;
  if (input.templateId && !preset) throw new Error('EDIT_TEMPLATE_NOT_FOUND');
  let voiceAssetId = input.voiceAssetId;
  if (!voiceAssetId && input.voicePath) {
    const imported = await dependencies.assetService.importFile({ workspaceId: input.workspaceId, sourcePath: input.voicePath, kind: 'AUDIO', role: 'VOICE' });
    voiceAssetId = imported.id;
  }
  const rawSentences = segmentScriptSentences(input.script);
  let sentences = rawSentences;
  if (voiceAssetId) {
    const voice = await dependencies.assets.getReadyWorkspaceAsset(input.workspaceId, voiceAssetId, 'AUDIO', 'VOICE');
    const voiceDurationMs = Number(voice?.metadata.durationMs || 0);
    if (voiceDurationMs > 0) sentences = fitSentencesToVoiceDuration(rawSentences, voiceDurationMs);
  }
  let planned;
  if (input.mode === 'MIX') {
    planned = buildRandomSentenceMontageManifest({ workspaceId: input.workspaceId, sentences, assets: input.assets, seed: input.seed, minClipDurationMs: input.minClipDurationMs, maxClipDurationMs: input.maxClipDurationMs, preferUnusedMedia: input.preferUnusedMedia, ...(voiceAssetId ? { voiceAssetId } : {}) });
  } else {
    try {
      planned = buildScriptMontageManifest({ workspaceId: input.workspaceId, script: input.script, sentences, assets: input.assets, seed: input.seed, minClipDurationMs: input.minClipDurationMs, maxClipDurationMs: input.maxClipDurationMs, preferUnusedMedia: input.preferUnusedMedia, ...(input.resolvedAssignments ? { resolvedAssignments: input.resolvedAssignments } : {}), ...(voiceAssetId ? { voiceAssetId } : {}) });
    } catch (error) {
      if (input.assets.length !== 1 || !(error instanceof Error) || !error.message.includes('Adjacent duplicate clips')) throw error;
      planned = buildRandomSentenceMontageManifest({ workspaceId: input.workspaceId, sentences, assets: input.assets, seed: input.seed, minClipDurationMs: input.minClipDurationMs, maxClipDurationMs: input.maxClipDurationMs, preferUnusedMedia: input.preferUnusedMedia, ...(voiceAssetId ? { voiceAssetId } : {}) });
    }
  }
  planned.manifest.canvas.fps = input.fps;
  if (preset?.introAssetId || preset?.outroAssetId) {
    const branding = {
      ...(preset.introAssetId ? { intro: await dependencies.assets.getReadyGlobalVideoAssetContent(preset.introAssetId).then(async (asset) => {
        if (!asset) throw new Error('VIDEO_BRANDING_ASSET_INVALID');
        await dependencies.assets.attachToWorkspace(input.workspaceId, asset.id, 'SOURCE');
        return { id: asset.id, storageKey: asset.storageKey, sourcePath: dependencies.storage.objectPath(asset.storageKey), durationMs: Number(asset.metadata.durationMs || 0), role: 'INTRO' as const };
      }) } : {}),
      ...(preset.outroAssetId ? { outro: await dependencies.assets.getReadyGlobalVideoAssetContent(preset.outroAssetId).then(async (asset) => {
        if (!asset) throw new Error('VIDEO_BRANDING_ASSET_INVALID');
        await dependencies.assets.attachToWorkspace(input.workspaceId, asset.id, 'SOURCE');
        return { id: asset.id, storageKey: asset.storageKey, sourcePath: dependencies.storage.objectPath(asset.storageKey), durationMs: Number(asset.metadata.durationMs || 0), role: 'OUTRO' as const };
      }) } : {}),
    };
    planned.manifest = assembleBrandedTimeline(planned.manifest, branding);
  }
  const manifest = await dependencies.quickEdit.createPlannedManifest({ workspaceId: input.workspaceId, manifest: planned.manifest, createdBy: 'operator' });
  const job = await dependencies.video.createManifestRenderJobForWorkspace(input.workspaceId, manifest.id, input.renderIdempotencySuffix);
  return { ...(voiceAssetId ? { voiceAssetId } : {}), manifestId: manifest.id, renderJobId: job.id, renderJobState: job.state };
}
