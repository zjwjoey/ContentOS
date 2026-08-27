import { basename } from 'node:path';
import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';
import { JobRunner } from '../../../packages/modules/job/src/index.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { AssetCatalogService, AssetService } from '../../../packages/modules/asset/src/index.js';
import { VideoService } from '../../../packages/modules/video/src/index.js';
import { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { probeMedia } from '../../../packages/infrastructure/ffmpeg/src/index.js';
import { createDatabase } from '../../../packages/database/src/index.js';
import { loadConfig } from '../../../packages/config/src/index.js';
import { createVideoJobHandler, createVideoLeaseCancellationHandler, type VideoHandlerDeps } from './video-handler.js';

export interface VideoWorkerOptions extends VideoHandlerDeps { workerId?: string; reconcileIntervalMs?: number; pollIntervalMs?: number; concurrency?: number; }

class VideoWorkerRuntime extends WorkerRuntime {
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private consumptionTimer: NodeJS.Timeout | null = null;
  private activeReconciliation: Promise<void> | null = null;
  private activeConsumption: Promise<void> | null = null;
  constructor(workerId: string, private readonly reconcile: () => Promise<unknown>, private readonly consume: () => Promise<unknown>, private readonly reconcileIntervalMs: number, private readonly pollIntervalMs: number) { super(workerId); }
  private runReconciliation(): Promise<void> {
    if (this.activeReconciliation) return this.activeReconciliation;
    this.activeReconciliation = this.reconcile()
      .then(() => undefined)
      .catch((error: unknown) => { console.error(JSON.stringify({ level: 'error', event: 'video.lease_reconcile_failed', code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNKNOWN' })); })
      .finally(() => { this.activeReconciliation = null; });
    return this.activeReconciliation;
  }
  private runConsumption(): Promise<void> {
    if (this.activeConsumption) return this.activeConsumption;
    this.activeConsumption = this.consume()
      .then(() => undefined)
      .catch((error: unknown) => { console.error(JSON.stringify({ level: 'error', event: 'video.consume_failed', code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNKNOWN' })); })
      .finally(() => { this.activeConsumption = null; });
    return this.activeConsumption;
  }
  override async start(): Promise<void> {
    await this.runReconciliation();
    await super.start();
    this.reconciliationTimer = setInterval(() => { void this.runReconciliation(); }, this.reconcileIntervalMs);
    this.consumptionTimer = setInterval(() => { void this.runConsumption(); }, this.pollIntervalMs);
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
    await super.shutdown(signal);
  }
}

export function createVideoWorker(options?: VideoWorkerOptions): WorkerRuntime {
  if (!options) {
    const runtime = new WorkerRuntime('video-worker');
    runtime.register('video.render', async () => ({ status: 'NOT_IMPLEMENTED_STAGE_4_BOOTSTRAP' }));
    return runtime;
  }
  const reconcileIntervalMs = options.reconcileIntervalMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const concurrency = options.concurrency ?? 1;
  if (reconcileIntervalMs <= 0 || pollIntervalMs <= 0 || concurrency <= 0) throw new Error('Video worker intervals and concurrency must be positive');
  const runner = new JobRunner(options.jobs, options.workerId || 'video-worker');
  const handler = createVideoJobHandler(options);
  const recoverCancellation = createVideoLeaseCancellationHandler(options.video, options.storage);
  const consume = async (): Promise<void> => {
    const runnable = await options.jobs.listRunnable(['VIDEO_RENDER'], concurrency);
    await Promise.all(runnable.map((job) => runner.run(job.id, handler)));
  };
  const runtime = new VideoWorkerRuntime(options.workerId || 'video-worker', () => options.jobs.reconcileExpiredLeases(new Date(), recoverCancellation), consume, reconcileIntervalMs, pollIntervalMs);
  runtime.register('video.render', async (payload) => {
    const jobId = payload && typeof payload === 'object' ? (payload as { jobId?: unknown }).jobId : undefined;
    if (typeof jobId !== 'string' || !jobId) throw new Error('Video delivery requires jobId');
    return runner.run(jobId, handler);
  });
  return runtime;
}

if (basename(process.argv[1] ?? '') === 'main.ts') {
  const config = loadConfig();
  const db = await createDatabase(config.databaseUrl);
  const storage = new LocalStorageProvider(config.storageRoot);
  const jobs = new JobService(db);
  const assets = new AssetService(db, storage, (path) => probeMedia(path, config.ffprobePath));
  const video = new VideoService(db, storage, jobs, new AssetCatalogService(db));
  const worker = createVideoWorker({ db, storage, jobs, assets, video, ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath, fontFile: config.ffmpegFontFile, concurrency: config.videoWorkerConcurrency });
  const stop = async (signal: string): Promise<void> => { await worker.shutdown(signal); await db.end(); };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  await worker.start();
  console.log(JSON.stringify(worker.health()));
}
