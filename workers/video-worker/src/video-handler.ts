import { join } from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import type { AssetService, LocalMediaSourceService } from '../../../packages/modules/asset/src/index.js';
import type { JobLeaseCancellationHandler, JobRecord, JobService } from '../../../packages/modules/job/src/index.js';
import type { VideoService } from '../../../packages/modules/video/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { renderEditManifest } from '../../../packages/infrastructure/ffmpeg/src/index.js';

export interface VideoHandlerDeps { db: Pool; storage: LocalStorageProvider; assets: AssetService; jobs: JobService; video: VideoService; ffmpegPath: string; ffprobePath: string; fontFile?: string; localMedia?: LocalMediaSourceService; }

export function createVideoLeaseCancellationHandler(video: VideoService, storage: LocalStorageProvider): JobLeaseCancellationHandler {
  return async (job, scope) => {
    if (job.type !== 'VIDEO_RENDER') return false;
    await video.cancelCurrentRender(scope, { code: 'RENDER_CANCELLED', message: 'Worker lease expired after cancellation was requested' });
    const directory = join(storage.root, 'renders');
    const outputName = `${job.id}-${scope.attemptId}.mp4`;
    let names: string[];
    try { names = await readdir(directory); } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return true; throw error; }
    const attemptFiles = names.filter((name) => name === outputName || (name.startsWith(`${outputName}.`) && name.endsWith('.part.mp4')));
    await Promise.all(attemptFiles.map((name) => rm(join(directory, name), { force: true })));
    return true;
  };
}

export function createVideoJobHandler(deps: VideoHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, attemptId, signal) => {
    const planned = await deps.video.planJob(job);
    if (planned.renderStatus === 'SUCCEEDED' && planned.outputAssetId) return { manifestId: planned.manifestId, renderId: planned.renderId, outputAssetId: planned.outputAssetId };
    if (!attemptId || job.attemptCount <= 0) throw new Error('Video Render requires a claimed Job attempt');
    const start = await deps.jobs.withCurrentAttemptFence(job.id, attemptId, (scope) => deps.video.startRender(planned.renderId, scope, { seed: planned.manifest.seed }));
    if (!start.executed) return { manifestId: planned.manifestId, renderId: planned.renderId, staleAttempt: true };
    if (!start.value) throw Object.assign(new Error('Current Job attempt could not start its Render'), { code: 'RENDER_START_REJECTED', retryable: true });
    const outputPath = join(deps.storage.root, 'renders', `${job.id}-${attemptId}.mp4`);
    try {
      const rendered = await renderEditManifest({ manifest: planned.manifest, outputPath, ffmpegPath: deps.ffmpegPath, ffprobePath: deps.ffprobePath, signal, ...(deps.fontFile ? { fontFile: deps.fontFile } : {}) });
      const outputInput = { ...(job.projectId ? { projectId: job.projectId } : planned.manifest.workspaceId ? { workspaceId: planned.manifest.workspaceId } : {}), sourcePath: outputPath, kind: 'VIDEO_RENDER', role: 'OUTPUT' as const };
      const preparedOutput = await deps.assets.prepareFile(outputInput);
      const finalized = await deps.jobs.succeedWithCurrentAttempt(job.id, attemptId, async (scope) => {
        const outputAsset = await deps.assets.commitPrepared(outputInput, preparedOutput, scope);
        const completed = await deps.video.completeRender(planned.renderId, scope, outputAsset.id, { durationMs: rendered.durationMs, width: rendered.width, height: rendered.height, format: rendered.format, outputAssetId: outputAsset.id });
        if (!completed) throw Object.assign(new Error('Current Job attempt could not complete its Render'), { code: 'RENDER_FENCE_REJECTED', retryable: true });
        return { manifestId: planned.manifestId, renderId: planned.renderId, outputAssetId: outputAsset.id, diagnostics: rendered };
      });
      if (finalized.executed) {
        if (deps.localMedia && job.projectId) {
          const mediaIds = planned.manifest.timeline
            .filter((clip) => clip.assetId.startsWith('local-'))
            .map((clip) => clip.assetId);
          if (mediaIds.length > 0) await deps.localMedia.recordUsage({ projectId: job.projectId, manifestId: planned.manifestId, renderId: planned.renderId, mediaIds });
        }
        return finalized.value;
      }
      await deps.jobs.cancelAttempt(job.id, attemptId, async (scope) => { await deps.video.cancelRender(planned.renderId, scope, { code: 'RENDER_CANCELLED', message: 'Cancellation won before final commit' }); });
      return { manifestId: planned.manifestId, renderId: planned.renderId, staleAttempt: true };
    } catch (error) {
      const diagnostics = { code: signal.aborted ? 'RENDER_CANCELLED' : 'RENDER_FAILED', message: error instanceof Error ? error.message : 'unknown' };
      if (signal.aborted) {
        const cancelled = await deps.jobs.cancelAttempt(job.id, attemptId, async (scope) => { await deps.video.cancelRender(planned.renderId, scope, diagnostics); });
        if (cancelled.state === 'CANCELLED') throw error;
      }
      await deps.jobs.fail(job.id, attemptId, diagnostics, true, async (scope) => { await deps.video.failRender(planned.renderId, scope, diagnostics); });
      throw error;
    } finally { await rm(outputPath, { force: true }); }
  };
}

export function createLocalMediaScanJobHandler(deps: VideoHandlerDeps): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, attemptId, signal) => {
    if (job.type !== 'LOCAL_MEDIA_SCAN' || !deps.localMedia) throw new Error('Local media scan service is unavailable');
    const payload = job.payload as { scanId?: string; sourceRoot?: string; recursive?: boolean };
    if (!payload.scanId || !payload.sourceRoot) throw new Error('LOCAL_MEDIA_SCAN_PAYLOAD_INVALID');
    await deps.localMedia.markScanRunning(payload.scanId);
    try {
      const result = await deps.localMedia.scan({ sourceRoot: payload.sourceRoot, recursive: payload.recursive !== false, signal, onProgress: async (progress) => { await deps.jobs.updateProgress(job.id, attemptId, progress); await deps.localMedia!.updateScanProgress(payload.scanId!, progress); } });
      await deps.localMedia.completeScan(payload.scanId, result);
      for (const file of result.files.filter((item) => item.available)) {
        if (signal.aborted) throw new Error('LOCAL_MEDIA_SCAN_CANCELLED');
        try { await deps.localMedia.generateThumbnail(`${result.sourceRootId}:${file.relativePath}`, deps.ffmpegPath); } catch { /* thumbnail failure is recorded and must not hide a usable scan */ }
      }
      return { scanId: payload.scanId, sourceRootId: result.sourceRootId, totalCount: result.totalCount, availableCount: result.availableCount, unavailableCount: result.unavailableCount };
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof Error && error.message === 'LOCAL_MEDIA_SCAN_CANCELLED');
      await deps.localMedia.failScan(payload.scanId, { code: cancelled ? 'LOCAL_MEDIA_SCAN_CANCELLED' : 'LOCAL_MEDIA_SCAN_FAILED', message: error instanceof Error ? error.message : 'scan failed' }, cancelled ? 'CANCELLED' : 'FAILED');
      throw error;
    }
  };
}
