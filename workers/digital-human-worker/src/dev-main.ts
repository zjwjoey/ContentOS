import { createDatabase, migrateUp } from '../../../packages/database/src/index.js';
import { loadConfig } from '../../../packages/config/src/index.js';
import { AssetCatalogService, AssetService } from '../../../packages/modules/asset/src/index.js';
import { DigitalHumanService, createRuntimeDigitalHumanProviders } from '../../../packages/modules/digital-human/src/index.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { probeMedia } from '../../../packages/infrastructure/ffmpeg/src/index.js';
import { createDigitalHumanWorker } from './main.js';
import type { DigitalHumanWorkerDependencies } from './handler.js';
import { DIGITAL_HUMAN_JOB_TYPES } from './job-types.js';

export interface DigitalHumanDevRunnerOptions { pollIntervalMs?: number; batchSize?: number; recoveryIntervalMs?: number; }
export interface DigitalHumanDevRunner { start(): Promise<void>; stop(signal?: string): Promise<void>; pollOnce(): Promise<void>; recoverOnce(): Promise<void>; }

export function createDigitalHumanDevRunner(dependencies: DigitalHumanWorkerDependencies, options: DigitalHumanDevRunnerOptions = {}): DigitalHumanDevRunner {
  const pollIntervalMs = options.pollIntervalMs ?? 250; const batchSize = options.batchSize ?? 10; const recoveryIntervalMs = options.recoveryIntervalMs ?? 5_000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0 || !Number.isInteger(batchSize) || batchSize <= 0 || !Number.isInteger(recoveryIntervalMs) || recoveryIntervalMs <= 0) throw new Error('Digital Human runner options must be positive integers');
  const runtime = createDigitalHumanWorker(dependencies); let pollTimer: NodeJS.Timeout | undefined; let recoveryTimer: NodeJS.Timeout | undefined; let started = false; let polling = false; let recovering = false;
  const pollOnce = async (): Promise<void> => { if (polling) return; polling = true; try { const jobs = await dependencies.jobs.listRunnable(DIGITAL_HUMAN_JOB_TYPES, batchSize); await Promise.all(jobs.map((job) => runtime.execute(job.type, { jobId: job.id }))); } finally { polling = false; } };
  const recoverOnce = async (): Promise<void> => { if (recovering) return; recovering = true; try { await dependencies.jobs.reconcileExpiredLeases(new Date()); } finally { recovering = false; } };
  return {
    pollOnce, recoverOnce,
    async start() { if (started) return; await recoverOnce(); await runtime.start(); started = true; await pollOnce(); pollTimer = setInterval(() => { void pollOnce(); }, pollIntervalMs); recoveryTimer = setInterval(() => { void recoverOnce(); }, recoveryIntervalMs); pollTimer.unref(); recoveryTimer.unref(); },
    async stop(signal = 'SIGTERM') { if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; } if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = undefined; } if (!started) return; await runtime.shutdown(signal); started = false; },
  };
}

async function startLocalWorker(): Promise<void> {
  const config = loadConfig(); const db = await createDatabase(config.databaseUrl); await migrateUp(db); const storage = new LocalStorageProvider(config.storageRoot); const jobs = new JobService(db); const assets = new AssetCatalogService(db); const providers = createRuntimeDigitalHumanProviders({ CONTENTOS_SPEECH_PROVIDER: config.digitalHumanSpeechProvider, CONTENTOS_INDEXTTS_BASE_URL: config.indexttsBaseUrl, CONTENTOS_AVATAR_PROVIDER: config.digitalHumanAvatarProvider, HZAGENT_BASE_URL: config.avatarBaseUrl, HZAGENT_API_KEY: config.avatarApiKey, ...(config.avatarCapabilitiesPath ? { HZAGENT_CAPABILITIES_PATH: config.avatarCapabilitiesPath } : {}), ...(config.avatarSubmitPath ? { HZAGENT_SUBMIT_PATH: config.avatarSubmitPath } : {}), ...(config.avatarTaskPath ? { HZAGENT_TASK_PATH: config.avatarTaskPath } : {}), ...(config.avatarAuthHeader ? { HZAGENT_AUTH_HEADER: config.avatarAuthHeader } : {}), HZAGENT_AUTH_SCHEME: config.avatarAuthScheme, CONTENTOS_MEDIA_STAGING_PROVIDER: config.mediaStagingProvider, CONTENTOS_MEDIA_STAGING_BASE_URL: config.mediaStagingBaseUrl, CONTENTOS_MEDIA_STAGING_API_KEY: config.mediaStagingApiKey, CONTENTOS_MEDIA_STAGING_SECRET: config.mediaStagingSecret });
  const dependencies: DigitalHumanWorkerDependencies = { jobs, digitalHuman: new DigitalHumanService(db, jobs, assets), assets, assetService: new AssetService(db, storage, (path) => probeMedia(path, config.ffprobePath)), storage, speechProvider: providers.speech, avatarProvider: providers.avatar, staging: providers.staging };
  const runner = createDigitalHumanDevRunner(dependencies, { pollIntervalMs: config.digitalHumanPollIntervalMs, batchSize: config.digitalHumanWorkerConcurrency }); await runner.start();
  const close = async (signal: string) => { await runner.stop(signal); await db.end(); }; process.once('SIGINT', () => { void close('SIGINT'); }); process.once('SIGTERM', () => { void close('SIGTERM'); });
}

if (process.argv[1]?.endsWith('dev-main.ts')) await startLocalWorker();
