import { join } from 'node:path';
import { createDatabase, migrateUp } from '../../../packages/database/src/index.js';
import { loadConfig } from '../../../packages/config/src/index.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { ProjectService } from '../../../packages/modules/project/src/index.js';
import { AssetCatalogService } from '../../../packages/modules/asset/src/index.js';
import { DouyinOpenApiAdapter, EnvironmentCredentialProvider, FakePublisherService, FakePublisherSimulationService, PublisherAdapterRegistry, PublisherService, PostgresPublishStateStore, WeChatChannelsPlaywrightAdapter } from '../../../packages/modules/publisher/src/index.js';
import { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { PlaywrightBrowserSessionFactory } from '../../../packages/infrastructure/playwright/src/index.js';
import { createPublisherWorker, PUBLISH_RECONCILE_JOB_TYPE, PUBLISH_VALIDATE_ACCOUNT_JOB_TYPE, type PublisherWorkerOptions } from './main.js';

export interface PublisherDevRunnerOptions { pollIntervalMs?: number; batchSize?: number; }
export interface PublisherDevRunner { start(): Promise<void>; stop(signal?: string): Promise<void>; pollOnce(): Promise<void>; }

export function createPublisherDevRunner(dependencies: PublisherWorkerOptions, options: PublisherDevRunnerOptions = {}): PublisherDevRunner {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const batchSize = options.batchSize ?? 10;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('Publisher poll interval must be a positive integer');
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('Publisher batch size must be a positive integer');
  const runtime = createPublisherWorker(dependencies);
  let timer: NodeJS.Timeout | undefined;
  let started = false;
  let polling = false;

  const pollOnce = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const jobs = await dependencies.jobs.listRunnable(['PUBLISH', PUBLISH_RECONCILE_JOB_TYPE, PUBLISH_VALIDATE_ACCOUNT_JOB_TYPE], batchSize);
      for (const job of jobs) await runtime.execute(job.type, { jobId: job.id });
    } finally { polling = false; }
  };

  return {
    pollOnce,
    async start() {
      if (started) return;
      await runtime.start();
      started = true;
      await pollOnce();
      timer = setInterval(() => { void pollOnce(); }, pollIntervalMs);
    },
    async stop(signal = 'SIGTERM') {
      if (timer) { clearInterval(timer); timer = undefined; }
      if (!started) return;
      await runtime.shutdown(signal);
      started = false;
    },
  };
}

async function startLocalWorker(): Promise<void> {
  const config = loadConfig();
  const db = await createDatabase(config.databaseUrl);
  await migrateUp(db);
  const jobs = new JobService(db);
  const storage = new LocalStorageProvider(config.storageRoot);
  const registry = new PublisherAdapterRegistry();
  if (config.publisherRealAdaptersEnabled) {
    const state = new PostgresPublishStateStore(db);
    registry.register(new DouyinOpenApiAdapter(undefined, state));
    registry.register(new WeChatChannelsPlaywrightAdapter(new PlaywrightBrowserSessionFactory(), { headed: config.publisherWechatHeaded, allowSubmit: config.publisherWechatAllowSubmit, evidenceDir: config.publisherEvidenceRoot }, state));
  }
  const fakeSimulations = process.env.CONTENTOS_FAKE_PUBLISHER_CONTROLS === '1' ? new FakePublisherSimulationService(db) : undefined;
  const runner = createPublisherDevRunner({
    jobs,
    service: new PublisherService(db),
    projects: new ProjectService(db),
    assets: new AssetCatalogService(db),
    fakePublisher: new FakePublisherService(join(config.storageRoot, 'publisher-profiles')),
    ...(fakeSimulations ? { fakeSimulations } : {}),
    adapterRegistry: registry,
    credentials: new EnvironmentCredentialProvider(),
    storage,
    profileRoot: config.publisherProfileRoot,
    realAdaptersEnabled: config.publisherRealAdaptersEnabled,
    workerId: 'publisher-worker-dev',
  });
  await runner.start();
  const close = async (signal: string) => { await runner.stop(signal); await db.end(); };
  process.once('SIGINT', () => { void close('SIGINT'); });
  process.once('SIGTERM', () => { void close('SIGTERM'); });
}

if (process.argv[1]?.endsWith('dev-main.ts')) await startLocalWorker();
