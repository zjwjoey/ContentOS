import type { JobLeaseRecoveryHandler } from '../../../packages/modules/job/src/index.js';
import type { VideoHandlerDeps } from './video-handler.js';

export const VIDEO_JOB_TYPES = ['VIDEO_RENDER', 'LOCAL_MEDIA_SCAN', 'EDIT_PREPARE_ITEM', 'EDIT_EXPORT', 'EDIT_SCRIPT_PLAN', 'ANALYZE_ASSET_VISUAL', 'GENERATE_REPRESENTATIVE_FRAMES', 'IMPORT_JIANYING_DRAFT', 'SHOT_DETECTION_V1', 'EDIT_V3_DRAFT_PREVIEW'] as const;

export function createVideoLeaseRecoveryHandler(deps: Pick<VideoHandlerDeps, 'video' | 'localMedia'>): JobLeaseRecoveryHandler {
  return async (job, scope, context) => {
    if (job.type === 'LOCAL_MEDIA_SCAN') return deps.localMedia ? deps.localMedia.recoverScanLeaseWithExecutor(scope, job, context) : false;
    return deps.video.recoverLeaseWithExecutor(scope, job, context);
  };
}
