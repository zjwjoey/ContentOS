import type { JobAttemptScope, JobRecord, OwnerRecoveryAttemptScope } from '../../job/src/index.js';

export interface AnalysisAttemptLink { runId: string; jobId: string; projectId: string; assetId: string; sourceChecksum: string | null; }
export interface AnalysisAttemptIdentity extends AnalysisAttemptLink { attemptId: string; attemptNumber: number; generation: number; }
export type AnalysisStartDecision = { kind: 'REUSE' | 'STARTED'; identity: AnalysisAttemptIdentity };
type Run = { id: string; job_id: string | null; project_id: string; asset_id: string; source_checksum: string | null; status: string; attempt_count: number; active_job_attempt_id: string | null; active_job_attempt_number: number | null; };
function stale(code = 'MEDIA_ANALYSIS_STALE_OWNER'): never { throw Object.assign(new Error(code), { code, control: 'STALE' }); }
function matches(scope: JobAttemptScope, link: AnalysisAttemptLink, row: Run | undefined): row is Run {
  return !!row && [link.runId, link.jobId, link.projectId, link.assetId, scope.attemptId].every((id) => typeof id === 'string' && id.trim().length > 0)
    && Number.isSafeInteger(scope.attemptNumber) && scope.attemptNumber > 0 && scope.jobId === link.jobId && scope.projectId === link.projectId && scope.type === 'MEDIA_ANALYSIS'
    && row.id === link.runId && row.job_id === link.jobId && row.project_id === link.projectId && row.asset_id === link.assetId;
}
async function lock(scope: JobAttemptScope, link: AnalysisAttemptLink): Promise<Run> {
  const row = (await scope.query<Run>('select * from media_analysis_runs where id=$1 for update', [link.runId])).rows[0];
  if (!matches(scope, link, row)) stale();
  return row;
}
function bound(scope: JobAttemptScope, identity: AnalysisAttemptIdentity, row: Run): boolean {
  return scope.attemptId === identity.attemptId && scope.attemptNumber === identity.attemptNumber
    && row.active_job_attempt_id === scope.attemptId && Number(row.active_job_attempt_number) === scope.attemptNumber
    && Number.isSafeInteger(identity.generation) && identity.generation > 0 && Number(row.attempt_count) === identity.generation;
}

// Same-connection owner ports only. No providers, pool calls or Job-private SQL.
// Callers must use Job fences and catch STALE outside the transaction/coordinator.
export class MediaAnalysisAttemptOwner {
  async start(scope: OwnerRecoveryAttemptScope, link: AnalysisAttemptLink): Promise<AnalysisStartDecision> {
    const row = await lock(scope, link);
    const previous = row.active_job_attempt_number === null ? null : Number(row.active_job_attempt_number);
    if (previous !== null && (previous > scope.attemptNumber || (previous === scope.attemptNumber && row.active_job_attempt_id !== scope.attemptId))) stale();
    if (row.status === 'SUCCEEDED') {
      if (row.source_checksum !== link.sourceChecksum) stale('MEDIA_ANALYSIS_SOURCE_CHANGED');
      await scope.query('update media_analysis_runs set active_job_attempt_id=$2,active_job_attempt_number=$3 where id=$1', [link.runId, scope.attemptId, scope.attemptNumber]);
      return { kind: 'REUSE', identity: { ...link, attemptId: scope.attemptId, attemptNumber: scope.attemptNumber, generation: Number(row.attempt_count) } };
    }
    if (row.status === 'RUNNING' && row.active_job_attempt_id === scope.attemptId) stale('MEDIA_ANALYSIS_DUPLICATE_START');
    if (row.status === 'RUNNING' || (previous === null && row.status !== 'QUEUED')) stale('MEDIA_ANALYSIS_LEGACY_DRAIN_REQUIRED');
    if (!['QUEUED', 'FAILED', 'CANCELLED'].includes(row.status) || (previous !== null && previous >= scope.attemptNumber)) stale();
    const started = await scope.query<{ attempt_count: number }>("update media_analysis_runs set status='RUNNING',active_job_attempt_id=$2,active_job_attempt_number=$3,attempt_count=attempt_count+1,source_checksum=$4,started_at=coalesce(started_at,now()),finished_at=null,error=null where id=$1 returning attempt_count", [link.runId, scope.attemptId, scope.attemptNumber, link.sourceChecksum]);
    return { kind: 'STARTED', identity: { ...link, attemptId: scope.attemptId, attemptNumber: scope.attemptNumber, generation: Number(started.rows[0]!.attempt_count) } };
  }

  async finish(scope: JobAttemptScope, identity: AnalysisAttemptIdentity, outcome: 'REUSE' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED', error?: { code: string; message: string }): Promise<{ kind: 'REUSE' | 'TERMINAL' }> {
    const row = await lock(scope, identity);
    if (!bound(scope, identity, row) || row.source_checksum !== identity.sourceChecksum) stale('MEDIA_ANALYSIS_STALE_GENERATION');
    if (outcome === 'REUSE') {
      if (row.status !== 'SUCCEEDED' || row.source_checksum !== identity.sourceChecksum) stale();
      return { kind: 'REUSE' };
    }
    if (row.status !== 'RUNNING') stale();
    await scope.query('update media_analysis_runs set status=$2,error=$3,finished_at=coalesce(finished_at,now()) where id=$1', [identity.runId, outcome, outcome === 'SUCCEEDED' ? null : error ?? { code: `MEDIA_ANALYSIS_${outcome}`, message: `Media analysis ${outcome.toLowerCase()}` }]);
    return { kind: 'TERMINAL' };
  }

  async recover(job: JobRecord, scope: JobAttemptScope, outcome: 'RETRY_WAIT' | 'CANCELLED'): Promise<void> {
    if (job.type !== 'MEDIA_ANALYSIS' || job.id !== scope.jobId || job.attemptCount !== scope.attemptNumber || !job.projectId) stale();
    const rows = (await scope.query<Run>('select * from media_analysis_runs where job_id=$1 for update', [scope.jobId])).rows;
    if (rows.length !== 1) stale();
    const row = rows[0]!;
    if (row.project_id !== job.projectId || row.active_job_attempt_id !== scope.attemptId || Number(row.active_job_attempt_number) !== scope.attemptNumber) stale();
    if (row.status === 'SUCCEEDED') return; // Validated completed-result reuse, never rewritten by recovery.
    if (row.status !== 'RUNNING') stale();
    await scope.query('update media_analysis_runs set status=$2,error=$3,finished_at=case when $2=\'CANCELLED\' then coalesce(finished_at,now()) else null end where id=$1', [row.id, outcome === 'CANCELLED' ? 'CANCELLED' : 'QUEUED', { code: outcome === 'CANCELLED' ? 'MEDIA_ANALYSIS_LEASE_CANCELLED' : 'MEDIA_ANALYSIS_LEASE_RECOVERED', message: 'Media analysis lease reconciled' }]);
  }
}
