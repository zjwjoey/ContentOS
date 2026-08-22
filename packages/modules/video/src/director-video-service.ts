import type { DirectorRevision, DirectorService, DirectorV1Service } from '../../director/src/index.js';
import { VideoService } from './video-service.js';
import type { JobRecord } from '../../job/src/index.js';

export interface DirectorVideoOptions { targetDurationMs?: number; voiceAssetId?: string; subtitleText?: string; seed?: number; videoAssetIds?: string[]; }

export class DirectorVideoService {
  constructor(private readonly director: DirectorService | DirectorV1Service, private readonly video: VideoService) {}

  async createVideoJob(projectId: string, options: DirectorVideoOptions = {}): Promise<JobRecord> {
    if ('getCurrentPair' in this.director) {
      const current = await this.director.getCurrentPair(projectId);
      if (!current.brief || !current.script || current.script.status !== 'ACCEPTED' || !current.storyboard || current.storyboard.status !== 'APPROVED') throw new Error('An approved Script and Storyboard pair is required before creating a Video Job');
      const videoAssetIds = options.videoAssetIds ?? [];
      if (videoAssetIds.length === 0) throw new Error('Approved Director pair requires explicit videoAssetIds');
      const targetDurationMs = options.targetDurationMs || current.storyboard.scenes.reduce((total, scene) => total + Math.round(scene.durationHintSeconds * 1000), 0);
      const seed = options.seed ?? 1;
      return this.video.createJob({ projectId, videoAssetIds, targetDurationMs, seed, ...(options.voiceAssetId ? { voiceAssetId: options.voiceAssetId } : {}), ...(options.subtitleText ? { subtitleText: options.subtitleText } : {}), idempotencyKey: `video-render:director-v1:${projectId}:${current.storyboard.id}`, metadata: { briefId: current.brief.id, scriptRevisionId: current.script.id, storyboardRevisionId: current.storyboard.id } });
    }
    const approved = await this.director.getCurrent(projectId);
    if (!approved) throw new Error('An approved Director revision is required before creating a Video Job');
    const plan = approved.plan;
    const videoAssetIds = [...new Set(plan.storyboard.flatMap((scene) => scene.sourceAssetIds))];
    if (videoAssetIds.length === 0) throw new Error('Approved Director plan has no source video assets');
    const targetDurationMs = options.targetDurationMs || plan.storyboard.reduce((total, scene) => total + scene.durationMs, 0);
    const seed = options.seed ?? plan.seed;
    const input = { projectId, videoAssetIds, targetDurationMs, seed, ...(options.voiceAssetId ? { voiceAssetId: options.voiceAssetId } : {}), ...(options.subtitleText ? { subtitleText: options.subtitleText } : {}), idempotencyKey: `video-render:director:${projectId}:${approved.id}`, directorRevisionId: approved.id, directorRevision: approved.revision, directorBrief: plan.brief, directorStoryboard: plan.storyboard };
    return this.video.createJob(input);
  }
}
