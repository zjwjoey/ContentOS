import { createHash } from 'node:crypto';
import type { DirectorRevision, DirectorService, DirectorV1Service } from '../../director/src/index.js';
import { VideoService } from './video-service.js';
import type { JobRecord } from '../../job/src/index.js';

export interface DirectorVideoOptions { targetDurationMs?: number; voiceAssetId?: string; subtitleText?: string; seed?: number; videoAssetIds?: string[]; }

function renderInputFingerprint(input: { videoAssetIds: string[]; targetDurationMs: number; seed: number; voiceAssetId?: string; subtitleText?: string }): string {
  return createHash('sha256').update(JSON.stringify({
    videoAssetIds: input.videoAssetIds,
    targetDurationMs: input.targetDurationMs,
    seed: input.seed,
    voiceAssetId: input.voiceAssetId ?? null,
    subtitleText: input.subtitleText ?? null,
  })).digest('hex').slice(0, 16);
}

export class DirectorVideoService {
  constructor(private readonly director: DirectorService | DirectorV1Service, private readonly video: VideoService, private readonly legacyDirector?: DirectorService) {}

  async createVideoJob(projectId: string, options: DirectorVideoOptions = {}): Promise<JobRecord> {
    if ('getCurrentVideoInput' in this.director) {
      const current = await this.director.getCurrentVideoInput(projectId);
      if (current) {
        if (!current.brief || !current.script || current.script.status !== 'ACCEPTED' || !current.storyboard || current.storyboard.status !== 'APPROVED') throw new Error('An approved Script and Storyboard pair is required before creating a Video Job');
        const videoAssetIds = options.videoAssetIds ?? [];
        if (videoAssetIds.length === 0) throw new Error('Approved Director pair requires explicit videoAssetIds');
        const targetDurationMs = options.targetDurationMs || current.storyboard.scenes.reduce((total, scene) => total + Math.round(scene.durationHintSeconds * 1000), 0);
        const seed = options.seed ?? 1;
        const fingerprint = renderInputFingerprint({ videoAssetIds, targetDurationMs, seed, ...(options.voiceAssetId ? { voiceAssetId: options.voiceAssetId } : {}), ...(options.subtitleText ? { subtitleText: options.subtitleText } : {}) });
        return this.video.createJob({ projectId, videoAssetIds, targetDurationMs, seed, ...(options.voiceAssetId ? { voiceAssetId: options.voiceAssetId } : {}), ...(options.subtitleText ? { subtitleText: options.subtitleText } : {}), idempotencyKey: `video-render:director-v1:${projectId}:${current.storyboard.id}:${fingerprint}`, metadata: { briefId: current.brief.id, scriptRevisionId: current.script.id, storyboardRevisionId: current.storyboard.id } });
      }
      if (this.legacyDirector) return this.createLegacyVideoJob(projectId, options, this.legacyDirector);
      throw new Error('An approved Script and Storyboard pair is required before creating a Video Job');
    }
    return this.createLegacyVideoJob(projectId, options, this.director);
  }

  private async createLegacyVideoJob(projectId: string, options: DirectorVideoOptions, director: DirectorService): Promise<JobRecord> {
    const approved = await director.getCurrent(projectId);
    if (!approved) throw new Error('An approved Director revision is required before creating a Video Job');
    const plan = approved.plan;
    const videoAssetIds = [...new Set(plan.storyboard.flatMap((scene) => scene.sourceAssetIds))];
    if (videoAssetIds.length === 0) throw new Error('Approved Director plan has no source video assets');
    const targetDurationMs = options.targetDurationMs || plan.storyboard.reduce((total, scene) => total + scene.durationMs, 0);
    const seed = options.seed ?? plan.seed;
    const fingerprint = renderInputFingerprint({ videoAssetIds, targetDurationMs, seed, ...(options.voiceAssetId ? { voiceAssetId: options.voiceAssetId } : {}), ...(options.subtitleText ? { subtitleText: options.subtitleText } : {}) });
    const input = { projectId, videoAssetIds, targetDurationMs, seed, ...(options.voiceAssetId ? { voiceAssetId: options.voiceAssetId } : {}), ...(options.subtitleText ? { subtitleText: options.subtitleText } : {}), idempotencyKey: `video-render:director:${projectId}:${approved.id}:${fingerprint}`, directorRevisionId: approved.id, directorRevision: approved.revision, directorBrief: plan.brief, directorStoryboard: plan.storyboard };
    return this.video.createJob(input);
  }
}
