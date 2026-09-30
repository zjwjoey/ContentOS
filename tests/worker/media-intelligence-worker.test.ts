import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaIntelligenceWorker } from '../../workers/media-intelligence-worker/src/main.js';
import { MEDIA_ANALYSIS } from '../../packages/modules/intelligence/src/index.js';
import type { JobRecord, JobService } from '../../packages/modules/job/src/index.js';
import type { MediaIntelligenceService } from '../../packages/modules/intelligence/src/index.js';

function job(state: JobRecord['state'] = 'QUEUED'): JobRecord { return { id: 'job-media-worker-1', projectId: 'project-1', workspaceId: null, type: MEDIA_ANALYSIS, state, payload: { schemaVersion: 'MEDIA_ANALYSIS_JOB_V1', projectId: 'project-1', assetId: 'asset-1', runId: 'run-1', correlationId: 'corr-1' }, result: null, error: null, attemptCount: 0, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, progress: {} }; }

test('media intelligence worker polls, completes, restarts safely and reconciles cancellation', async () => {
  let current = job(); let polls = 0; let reconciliations = 0; let cancelledRun = false; let analyzed = 0;
  const jobs = {
    listRunnable: async (types: string[], concurrency: number) => { assert.deepEqual(types, [MEDIA_ANALYSIS]); assert.equal(concurrency, 1); polls += 1; return current.state === 'QUEUED' ? [current] : []; },
    get: async () => current,
    claim: async () => { current = { ...current, state: 'RUNNING', attemptCount: 1, leaseOwner: 'media-intelligence-worker-v15' }; return { job: current, attemptId: 'attempt-1' }; },
    heartbeat: async () => 'ACTIVE' as const,
    succeed: async (_id: string, _attempt: string, result: unknown) => { current = { ...current, state: 'SUCCEEDED', result }; return current; },
    fail: async () => { current = { ...current, state: 'FAILED' }; return current; },
    cancelAttempt: async () => { current = { ...current, state: 'CANCELLED' }; return current; },
    reconcileExpiredLeases: async (_now: Date, cancel: (record: JobRecord) => Promise<boolean>) => { reconciliations += 1; if (current.state === 'CANCEL_REQUESTED') { await cancel(current); } return 1; },
  } as unknown as JobService;
  const intelligence = { analyzeRun: async () => { analyzed += 1; return { id: 'run-1', assetId: 'asset-1', status: 'SUCCEEDED' }; }, markCancelled: async () => { cancelledRun = true; }, reconcileStaleRuns: async () => 0 } as unknown as MediaIntelligenceService;
  const worker = createMediaIntelligenceWorker({ jobs, intelligence }, { pollIntervalMs: 10, reconcileIntervalMs: 10 }); await worker.start(); await new Promise((resolve) => setTimeout(resolve, 60)); assert.equal(worker.health().status, 'READY'); assert.equal(current.state, 'SUCCEEDED'); assert.equal(analyzed, 1); assert.ok(polls > 0); assert.ok(reconciliations > 0); await worker.shutdown('TEST'); assert.equal(worker.health().status, 'STOPPED');
  const restarted = createMediaIntelligenceWorker({ jobs, intelligence }, { pollIntervalMs: 10, reconcileIntervalMs: 10 }); await restarted.start(); await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(analyzed, 1); await restarted.shutdown('TEST');
  current = { ...job('CANCEL_REQUESTED'), state: 'CANCEL_REQUESTED' }; const cancelledWorker = createMediaIntelligenceWorker({ jobs, intelligence }, { pollIntervalMs: 20, reconcileIntervalMs: 10 }); await cancelledWorker.start(); await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(cancelledRun, true); await cancelledWorker.shutdown('TEST');
});
