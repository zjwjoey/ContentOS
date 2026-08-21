import { join } from 'node:path';
import type { Pool } from 'pg';
import type { AssetService } from '../../../packages/modules/asset/src/index.js';
import type { JobRecord } from '../../../packages/modules/job/src/index.js';
import type { VideoService } from '../../../packages/modules/video/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { renderEditManifest } from '../../../packages/infrastructure/ffmpeg/src/index.js';

export interface VideoHandlerDeps { db: Pool; storage: LocalStorageProvider; assets: AssetService; video: VideoService; ffmpegPath: string; ffprobePath: string; fontFile?: string; }

export function createVideoJobHandler(deps: VideoHandlerDeps): (job: JobRecord) => Promise<unknown> {
  return async (job) => {
    const planned = await deps.video.planJob(job);
    await deps.video.updateRender(planned.renderId, 'RUNNING', { seed: planned.manifest.seed });
    const outputPath = join(deps.storage.root, 'renders', `${job.id}.mp4`);
    try {
      const rendered = await renderEditManifest({ manifest: planned.manifest, outputPath, ffmpegPath: deps.ffmpegPath, ffprobePath: deps.ffprobePath, ...(deps.fontFile ? { fontFile: deps.fontFile } : {}) });
      const outputAsset = await deps.assets.importFile({ projectId: job.projectId || planned.manifest.projectId, sourcePath: outputPath, kind: 'VIDEO_RENDER' });
      await deps.video.completeRender(planned.renderId, outputAsset.id, { durationMs: rendered.durationMs, width: rendered.width, height: rendered.height, format: rendered.format, outputAssetId: outputAsset.id });
      return { manifestId: planned.manifestId, renderId: planned.renderId, outputAssetId: outputAsset.id, diagnostics: rendered };
    } catch (error) {
      await deps.video.updateRender(planned.renderId, 'FAILED', { code: 'RENDER_FAILED', message: error instanceof Error ? error.message : 'unknown' });
      throw error;
    }
  };
}
