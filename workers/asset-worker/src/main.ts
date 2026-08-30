import { basename } from 'node:path';
import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';
import { JobRunner, JobService } from '../../../packages/modules/job/src/index.js';
import { AssetImportService, AssetService } from '../../../packages/modules/asset/src/index.js';
import { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { probeMedia } from '../../../packages/infrastructure/ffmpeg/src/index.js';
import { createDatabase } from '../../../packages/database/src/index.js';
import { loadConfig } from '../../../packages/config/src/index.js';
import { createAssetJobHandler, createAssetLeaseCancellationHandler, type AssetHandlerDeps } from './asset-handler.js';

export interface AssetWorkerOptions extends AssetHandlerDeps {
  workerId?: string;
  reconcileIntervalMs?: number;
  pollIntervalMs?: number;
  concurrency?: number;
  autoConsume?: boolean;
}

class AssetWorkerRuntime extends WorkerRuntime {
  private recoveryTimer: NodeJS.Timeout | null = null;
  private consumptionTimer: NodeJS.Timeout | null = null;
  private recoveryPass: Promise<void> | null = null;
  private consumptionPass: Promise<void> | null = null;
  constructor(
    workerId: string,
    private readonly recover: () => Promise<unknown>,
    private readonly consume: () => Promise<unknown>,
    private readonly recoveryIntervalMs: number,
    private readonly pollIntervalMs: number,
    private readonly autoConsume: boolean,
  ) {
    super(workerId);
  }
  private runRecovery(): Promise<void> {
    if (this.recoveryPass) return this.recoveryPass;
    this.recoveryPass = this.recover()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.recoveryPass = null;
      });
    return this.recoveryPass;
  }
  private runConsumption(): Promise<void> {
    if (this.consumptionPass) return this.consumptionPass;
    this.consumptionPass = this.consume()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.consumptionPass = null;
      });
    return this.consumptionPass;
  }
  override async start(): Promise<void> {
    await this.runRecovery();
    await super.start();
    this.recoveryTimer = setInterval(() => {
      void this.runRecovery();
    }, this.recoveryIntervalMs);
    this.recoveryTimer.unref();
    if (this.autoConsume) {
      this.consumptionTimer = setInterval(() => {
        void this.runConsumption();
      }, this.pollIntervalMs);
      this.consumptionTimer.unref();
      void this.runConsumption();
    }
  }
  override async shutdown(signal: string): Promise<void> {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    if (this.consumptionTimer) clearInterval(this.consumptionTimer);
    if (this.recoveryPass) await this.recoveryPass;
    if (this.consumptionPass) await this.consumptionPass;
    await super.shutdown(signal);
  }
}

export function createAssetWorker(options?: AssetWorkerOptions): WorkerRuntime {
  if (!options) {
    const runtime = new WorkerRuntime('asset-worker');
    runtime.register('asset.import', async () => ({ status: 'NOT_IMPLEMENTED_STAGE_2_BOOTSTRAP' }));
    return runtime;
  }
  const runner = new JobRunner(options.jobs, options.workerId || 'asset-worker');
  const handler = createAssetJobHandler(options);
  const concurrency = options.concurrency ?? 1;
  const recoveryIntervalMs = options.reconcileIntervalMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const autoConsume = options.autoConsume ?? true;
  const cancellation = createAssetLeaseCancellationHandler(options.imports, options.storage);
  const consume = async (): Promise<void> => {
    const runnable = await options.jobs.listRunnable(['ASSET_IMPORT'], concurrency);
    await Promise.all(runnable.map((job) => runner.run(job.id, handler)));
  };
  const runtime = new AssetWorkerRuntime(
    options.workerId || 'asset-worker',
    () => options.jobs.reconcileExpiredLeases(new Date(), cancellation),
    consume,
    recoveryIntervalMs,
    pollIntervalMs,
    autoConsume,
  );
  runtime.register('asset.import', async (payload) => {
    const jobId = payload && typeof payload === 'object' ? (payload as { jobId?: unknown }).jobId : undefined;
    if (typeof jobId !== 'string' || !jobId) throw new Error('Asset delivery requires jobId');
    return runner.run(jobId, handler);
  });
  runtime.register('asset.import.poll', async () => {
    const jobs = await options.jobs.listRunnable(['ASSET_IMPORT'], concurrency);
    return Promise.all(jobs.map((job) => runner.run(job.id, handler)));
  });
  return runtime;
}

if (basename(process.argv[1] ?? '') === 'main.ts') {
  const config = loadConfig();
  const db = await createDatabase(config.databaseUrl);
  const storage = new LocalStorageProvider(config.storageRoot);
  const jobs = new JobService(db);
  const imports = new AssetImportService(db);
  const assets = new AssetService(db, storage, (path) => probeMedia(path, config.ffprobePath));
  const worker = createAssetWorker({ db, storage, assets, imports, jobs, ffprobePath: config.ffprobePath, concurrency: config.assetWorkerConcurrency });
  const stop = async (signal: string): Promise<void> => {
    await worker.shutdown(signal);
    await db.end();
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  await worker.start();
  console.log(JSON.stringify(worker.health()));
}
