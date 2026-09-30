import type { JobRecord, JobService } from '../../../packages/modules/job/src/index.js';
import { MEDIA_ANALYSIS, MediaIntelligenceService } from '../../../packages/modules/intelligence/src/index.js';

export interface MediaAnalysisJobPayload { schemaVersion: 'MEDIA_ANALYSIS_JOB_V1'; projectId: string; assetId: string; runId: string; correlationId: string; }
export interface MediaIntelligenceWorkerDependencies { jobs: JobService; intelligence: MediaIntelligenceService; }

function payloadOf(job: JobRecord): MediaAnalysisJobPayload {
  const payload = job.payload as Partial<MediaAnalysisJobPayload>;
  if (payload.schemaVersion !== 'MEDIA_ANALYSIS_JOB_V1' || typeof payload.projectId !== 'string' || payload.projectId !== job.projectId || typeof payload.assetId !== 'string' || typeof payload.runId !== 'string' || typeof payload.correlationId !== 'string') throw Object.assign(new Error('Invalid Media Analysis Job payload'), { code: 'MEDIA_ANALYSIS_PAYLOAD_INVALID', retryable: false });
  return payload as MediaAnalysisJobPayload;
}

export function createMediaAnalysisJobHandler(deps: MediaIntelligenceWorkerDependencies): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, _attemptId, signal) => {
    if (job.type !== MEDIA_ANALYSIS) throw Object.assign(new Error(`Unexpected Media Analysis Job type: ${job.type}`), { code: 'MEDIA_ANALYSIS_JOB_TYPE_INVALID', retryable: false });
    const payload = payloadOf(job);
    signal.throwIfAborted();
    const run = await deps.intelligence.analyzeRun(payload.runId, signal);
    return { runId: run.id, assetId: run.assetId, status: run.status, schemaVersion: 'MEDIA_ANALYSIS_RESULT_V1' };
  };
}
