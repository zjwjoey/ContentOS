import type { DirectorRevision } from '../../director/src/index.js';
import type { DirectorService } from '../../director/src/index.js';
import { VideoService } from './video-service.js';
import type { JobRecord } from '../../job/src/index.js';

export interface DirectorVideoOptions { targetDurationMs?: number; voiceAssetId?: string; subtitleText?: string; seed?: number; }

export class DirectorVideoService {
  constructor(private readonly director: DirectorService, private readonly video: VideoService) {}

  async createVideoJob(projectId: string, options: DirectorVideoOptions = {}): Promise<JobRecord> {
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
