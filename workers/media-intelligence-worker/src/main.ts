import { basename } from 'node:path';
import type { Pool } from 'pg';
import { createDatabase } from '../../../packages/database/src/index.js';
import { loadConfig } from '../../../packages/config/src/index.js';
import { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';
import { JobRunner, JobService, type JobRecord } from '../../../packages/modules/job/src/index.js';
import { MEDIA_ANALYSIS, MediaIntelligenceService, createIntelligenceProviders } from '../../../packages/modules/intelligence/src/index.js';
import { createMediaAnalysisJobHandler, type MediaAnalysisJobPayload, type MediaIntelligenceWorkerDependencies } from './handler.js';

export type { MediaAnalysisJobPayload, MediaIntelligenceWorkerDependencies } from './handler.js';
export interface MediaIntelligenceWorkerOptions { workerId?: string; reconcileIntervalMs?: number; pollIntervalMs?: number; concurrency?: number; cancellationBatchSize?: number; }

export class MediaIntelligenceWorkerRuntime extends WorkerRuntime {
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private consumptionTimer: NodeJS.Timeout | null = null;
  private activeReconciliation: Promise<void> | null = null;
  private activeConsumption: Promise<void> | null = null;
  private activeQueuedCancellation: Promise<number> | null = null;
  private cancellationAfterId: string | null = null;
  private cancellationThroughId: string | null = null;
  constructor(private readonly dependencies: MediaIntelligenceWorkerDependencies, private readonly options: Required<MediaIntelligenceWorkerOptions>) { super(options.workerId); }
  private runReconciliation(): Promise<void> {
    if (this.activeReconciliation) return this.activeReconciliation;
    this.activeReconciliation = this.reconcile().catch((error: unknown) => { console.error(JSON.stringify({ level: 'error', event: 'media_intelligence.lease_reconcile_failed', code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNKNOWN' })); }).finally(() => { this.activeReconciliation = null; });
    return this.activeReconciliation;
  }
  private runConsumption(): Promise<void> {
    if (this.activeConsumption) return this.activeConsumption;
    this.activeConsumption = this.consume().catch((error: unknown) => { console.error(JSON.stringify({ level: 'error', event: 'media_intelligence.consume_failed', code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNKNOWN' })); }).finally(() => { this.activeConsumption = null; });
    return this.activeConsumption;
  }
  private async reconcile(): Promise<void> {
    await this.dependencies.jobs.reconcileExpiredLeases(new Date(), async (job: JobRecord) => {
      if (job.type !== MEDIA_ANALYSIS) return false;
      const payload = job.payload as Partial<MediaAnalysisJobPayload>;
      if (typeof payload.runId === 'string') await this.dependencies.intelligence.markCancelled(payload.runId, { code: 'MEDIA_ANALYSIS_LEASE_CANCELLED', message: 'Media analysis lease expired after cancellation request' });
      return true;
    });
    await this.dependencies.intelligence.reconcileStaleRuns();
    await this.reconcileQueuedCancellations();
  }
  reconcileQueuedCancellations(): Promise<number> {
    if (this.activeQueuedCancellation) return this.activeQueuedCancellation;
    this.activeQueuedCancellation = this.scanQueuedCancellations().finally(() => { this.activeQueuedCancellation = null; });
    return this.activeQueuedCancellation;
  }
  private async scanQueuedCancellations(): Promise<number> {
    let candidates = await this.dependencies.intelligence.listQueuedCancellationCandidates(this.cancellationAfterId, this.cancellationThroughId, this.options.cancellationBatchSize);
    if (!candidates.length && this.cancellationAfterId !== null) {
      this.cancellationAfterId = null;
      this.cancellationThroughId = null;
      candidates = await this.dependencies.intelligence.listQueuedCancellationCandidates(null, null, this.options.cancellationBatchSize);
    }
    let changed = 0;
    for (const candidate of candidates) {
      this.cancellationAfterId = candidate.runId;
      this.cancellationThroughId = candidate.throughId;
      try {
        if (![candidate.runId, candidate.jobId, candidate.projectId].every((id) => typeof id === 'string' && id.trim().length > 0)) continue;
        const job = await this.dependencies.jobs.get(candidate.jobId);
        if (!job || job.state !== 'CANCELLED' || job.type !== MEDIA_ANALYSIS || job.projectId !== candidate.projectId || !Number.isSafeInteger(job.attemptCount) || job.attemptCount < 0) continue;
        const result = await this.dependencies.jobs.withCancelledJobFence(job.id, { type: MEDIA_ANALYSIS, projectId: candidate.projectId, attemptCount: job.attemptCount }, (scope) => this.dependencies.intelligence.markQueuedCancelledWithExecutor(scope, candidate.runId, candidate.jobId, candidate.projectId));
        if (result.executed && result.value) changed += 1;
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', event: 'media_intelligence.queued_cancel_failed', code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNKNOWN' }));
      }
    }
    return changed;
  }
  async consume(): Promise<void> {
    const runnable = await this.dependencies.jobs.listRunnable([MEDIA_ANALYSIS], this.options.concurrency);
    if (!runnable.length) return;
    const runner = new JobRunner(this.dependencies.jobs, this.options.workerId);
    const handler = createMediaAnalysisJobHandler(this.dependencies);
    await Promise.all(runnable.map((job) => runner.run(job.id, handler)));
  }
  override async start(): Promise<void> {
    await this.runReconciliation();
    await super.start();
    this.reconciliationTimer = setInterval(() => { void this.runReconciliation(); }, this.options.reconcileIntervalMs);
    this.consumptionTimer = setInterval(() => { void this.runConsumption(); }, this.options.pollIntervalMs);
    this.reconciliationTimer.unref();
    this.consumptionTimer.unref();
    void this.runConsumption();
  }
  override async shutdown(signal: string): Promise<void> {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    if (this.consumptionTimer) clearInterval(this.consumptionTimer);
    this.reconciliationTimer = null;
    this.consumptionTimer = null;
    if (this.activeReconciliation) await this.activeReconciliation;
    if (this.activeConsumption) await this.activeConsumption;
    if (this.activeQueuedCancellation) await this.activeQueuedCancellation;
    await super.shutdown(signal);
  }
}

export function createMediaIntelligenceWorker(dependencies: MediaIntelligenceWorkerDependencies, options: MediaIntelligenceWorkerOptions = {}): MediaIntelligenceWorkerRuntime {
  const resolved: Required<MediaIntelligenceWorkerOptions> = { workerId: options.workerId || 'media-intelligence-worker-v15', reconcileIntervalMs: options.reconcileIntervalMs ?? 5_000, pollIntervalMs: options.pollIntervalMs ?? 250, concurrency: options.concurrency ?? 1, cancellationBatchSize: options.cancellationBatchSize ?? 25 };
  if (resolved.reconcileIntervalMs <= 0 || resolved.pollIntervalMs <= 0 || resolved.concurrency <= 0) throw new Error('Media intelligence worker intervals and concurrency must be positive');
  if (!Number.isSafeInteger(resolved.cancellationBatchSize) || resolved.cancellationBatchSize < 1 || resolved.cancellationBatchSize > 100) throw new Error('Media intelligence cancellation batch size must be between 1 and 100');
  const runtime = new MediaIntelligenceWorkerRuntime(dependencies, resolved);
  const handler = createMediaAnalysisJobHandler(dependencies);
  const runner = new JobRunner(dependencies.jobs, resolved.workerId);
  runtime.register(MEDIA_ANALYSIS, async (invocation) => {
    const jobId = (invocation as { jobId?: unknown } | undefined)?.jobId;
    if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Media intelligence worker invocation requires jobId');
    const job = await dependencies.jobs.get(jobId);
    if (!job) throw new Error('Media intelligence job not found');
    return runner.run(job.id, handler);
  });
  return runtime;
}

export async function createMediaIntelligenceWorkerFromConfig(config = loadConfig()): Promise<{ worker: MediaIntelligenceWorkerRuntime; db: Pool }> {
  const configuredDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (configuredDatabaseUrl && configuredDatabaseUrl !== config.databaseUrl) throw new Error('MEDIA_INTELLIGENCE_DATABASE_URL_MISMATCH');
  const db = await createDatabase(config.databaseUrl);
  const jobs = new JobService(db);
  const storage = new LocalStorageProvider(config.storageRoot);
  const providers = createIntelligenceProviders({ ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath, keyframeRoot: config.intelligenceKeyframeRoot, realProvidersEnabled: config.intelligenceRealProvidersEnabled, asrProvider: config.intelligenceAsrProvider, visionProvider: config.intelligenceVisionProvider, embeddingProvider: config.intelligenceEmbeddingProvider });
  const intelligence = new MediaIntelligenceService(db, providers, { storage, ffmpegPath: config.ffmpegPath, keyframeRoot: config.intelligenceKeyframeRoot });
  const worker = createMediaIntelligenceWorker({ jobs, intelligence }, { concurrency: config.intelligenceWorkerConcurrency });
  return { worker, db };
}

if (/^main\.(?:ts|js)$/u.test(basename(process.argv[1] ?? ''))) {
  const { worker, db } = await createMediaIntelligenceWorkerFromConfig();
  let stopping = false;
  const stop = async (signal: string): Promise<void> => { if (stopping) return; stopping = true; await worker.shutdown(signal); await db.end(); };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  await worker.start();
  console.log(JSON.stringify(worker.health()));
}
