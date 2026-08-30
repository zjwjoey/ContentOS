import type { DirectorService } from './director-service.js';
import type { DirectorProjectSummary, DirectorV1Service } from './director-v1-service.js';

export type ResolvedDirectorProjectSummary = DirectorProjectSummary | {
  source: 'LEGACY' | 'NONE';
  hasRevision: boolean;
  readyForVideo: boolean;
  activeScript: null;
  activeStoryboard: null;
  legacyRevisionId: string | null;
};

export class DirectorProjectReadService {
  constructor(private readonly v1: DirectorV1Service, private readonly legacy: DirectorService) {}

  async get(projectId: string): Promise<ResolvedDirectorProjectSummary> {
    const v1 = await this.v1.getProjectSummary(projectId);
    if (v1) return v1;
    const revisions = await this.legacy.list(projectId);
    const current = await this.legacy.getCurrent(projectId);
    return {
      source: revisions.length > 0 ? 'LEGACY' : 'NONE',
      hasRevision: revisions.length > 0,
      readyForVideo: current?.status === 'APPROVED',
      activeScript: null,
      activeStoryboard: null,
      legacyRevisionId: current?.id || null,
    };
  }
}
