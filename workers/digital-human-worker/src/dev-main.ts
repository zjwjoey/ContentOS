import { createDatabase, migrateUp } from '../../../packages/database/src/index.js';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../../../packages/config/src/index.js';
import { AssetCatalogService, AssetService } from '../../../packages/modules/asset/src/index.js';
import { DigitalHumanService, createRuntimeDigitalHumanProviders } from '../../../packages/modules/digital-human/src/index.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { probeMedia } from '../../../packages/infrastructure/ffmpeg/src/index.js';
import { createDigitalHumanWorker } from './main.js';
import { createDigitalHumanLeaseCancellationHandler, type DigitalHumanWorkerDependencies } from './handler.js';
import { DIGITAL_HUMAN_JOB_TYPES } from './job-types.js';
import type { ProviderMediaStaging } from '../../../packages/contracts/src/index.js';

/** Temporary development-only uploader for providers that cannot reach a local tunnel. */
class UguuMediaStaging implements ProviderMediaStaging {
  constructor(private readonly assets: AssetCatalogService, private readonly storage: LocalStorageProvider) {}
  async stageAsset(assetId: string, options: { projectId?: string } = {}): Promise<{ publicUrl: string; expiresAt: string }> {
    if (!options.projectId?.trim()) throw new Error('Temporary media staging requires a project binding');
    const asset = await this.assets.getReadyAssetForProviderStaging(options.projectId, assetId);
    if (!asset) throw new Error('Provider media asset is not ready');
    const bytes = await readFile(this.storage.objectPath(asset.storageKey));
    const filename = asset.originalName?.trim() || `${asset.id}.${asset.kind === 'VIDEO' ? 'mp4' : 'mp3'}`;
    const form = new FormData(); form.append('files[]', new Blob([bytes], { type: asset.kind === 'VIDEO' ? 'video/mp4' : 'audio/mpeg' }), filename);
    const response = await fetch('https://uguu.se/upload.php', { method: 'POST', body: form });
    if (!response.ok) throw new Error(`Temporary media upload failed (${response.status})`);
    const payload = await response.json() as { success?: boolean; files?: Array<{ url?: string }> };
    const publicUrl = payload.files?.[0]?.url?.trim();
    if (!payload.success || !publicUrl) throw new Error('Temporary media upload returned no URL');
    return { publicUrl, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
  }
}

export interface DigitalHumanDevRunnerOptions { pollIntervalMs?: number; batchSize?: number; recoveryIntervalMs?: number; }
export interface DigitalHumanDevRunner { start(): Promise<void>; stop(signal?: string): Promise<void>; pollOnce(): Promise<void>; recoverOnce(): Promise<void>; }

export function createDigitalHumanDevRunner(dependencies: DigitalHumanWorkerDependencies, options: DigitalHumanDevRunnerOptions = {}): DigitalHumanDevRunner {
  const pollIntervalMs = options.pollIntervalMs ?? 250; const batchSize = options.batchSize ?? 10; const recoveryIntervalMs = options.recoveryIntervalMs ?? 5_000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0 || !Number.isInteger(batchSize) || batchSize <= 0 || !Number.isInteger(recoveryIntervalMs) || recoveryIntervalMs <= 0) throw new Error('Digital Human runner options must be positive integers');
  const runtime = createDigitalHumanWorker(dependencies); const cancellation = createDigitalHumanLeaseCancellationHandler(dependencies); let pollTimer: NodeJS.Timeout | undefined; let recoveryTimer: NodeJS.Timeout | undefined; let started = false; let pollingPass: Promise<void> | null = null; let recoveryPass: Promise<void> | null = null;
  const pollOnce = async (): Promise<void> => { if (pollingPass) return pollingPass; pollingPass = (async () => { const jobs = await dependencies.jobs.listRunnable(DIGITAL_HUMAN_JOB_TYPES, batchSize); await Promise.all(jobs.map((job) => runtime.execute(job.type, { jobId: job.id }))); })().finally(() => { pollingPass = null; }); return pollingPass; };
  const recoverOnce = async (): Promise<void> => { if (recoveryPass) return recoveryPass; recoveryPass = dependencies.jobs.reconcileExpiredLeases(new Date(), cancellation).then(() => undefined).finally(() => { recoveryPass = null; }); return recoveryPass; };
  return {
    pollOnce, recoverOnce,
    async start() { if (started) return; await recoverOnce(); await runtime.start(); started = true; await pollOnce(); pollTimer = setInterval(() => { void pollOnce().catch(() => undefined); }, pollIntervalMs); recoveryTimer = setInterval(() => { void recoverOnce().catch(() => undefined); }, recoveryIntervalMs); pollTimer.unref(); recoveryTimer.unref(); },
    async stop(signal = 'SIGTERM') { if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; } if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = undefined; } if (pollingPass) await pollingPass; if (recoveryPass) await recoveryPass; if (!started) return; await runtime.shutdown(signal); started = false; },
  };
}

export async function startLocalWorker(): Promise<void> {
  const config = loadConfig(); const db = await createDatabase(config.databaseUrl); if (process.env.CONTENTOS_SKIP_MIGRATIONS !== '1') await migrateUp(db); const storage = new LocalStorageProvider(config.storageRoot); const jobs = new JobService(db); const assets = new AssetCatalogService(db); const providers = createRuntimeDigitalHumanProviders({ CONTENTOS_SPEECH_PROVIDER: config.digitalHumanSpeechProvider, CONTENTOS_INDEXTTS_BASE_URL: config.indexttsBaseUrl, CONTENTOS_AVATAR_PROVIDER: config.digitalHumanAvatarProvider, ...(process.env.CONTENTOS_HZAGENT_BASE_URL ? { CONTENTOS_HZAGENT_BASE_URL: process.env.CONTENTOS_HZAGENT_BASE_URL } : {}), ...(process.env.CONTENTOS_HZAGENT_API_KEY ? { CONTENTOS_HZAGENT_API_KEY: process.env.CONTENTOS_HZAGENT_API_KEY } : {}), CONTENTOS_MEDIA_STAGING_PROVIDER: config.mediaStagingProvider, CONTENTOS_MEDIA_STAGING_BASE_URL: config.mediaStagingBaseUrl, CONTENTOS_MEDIA_STAGING_SECRET: config.mediaStagingSecret, ...(process.env.CONTENTOS_FAKE_SPEECH_OUTPUT_PATH ? { CONTENTOS_FAKE_SPEECH_OUTPUT_PATH: process.env.CONTENTOS_FAKE_SPEECH_OUTPUT_PATH } : {}), ...(process.env.CONTENTOS_FAKE_AVATAR_OUTPUT_URL ? { CONTENTOS_FAKE_AVATAR_OUTPUT_URL: process.env.CONTENTOS_FAKE_AVATAR_OUTPUT_URL } : {}), CONTENTOS_PROVIDER_REQUEST_TIMEOUT_MS: String(config.digitalHumanProviderRequestTimeoutMs), CONTENTOS_PROVIDER_CAPABILITY_TIMEOUT_MS: String(config.digitalHumanProviderCapabilityTimeoutMs) });
  const fakeAvatarOutputUrl = process.env.CONTENTOS_FAKE_AVATAR_OUTPUT_URL;
  const fakeAvatarProxyUrl = process.env.CONTENTOS_FAKE_AVATAR_PROXY_URL;
  const fakeAvatarBoundary = providers.avatar.providerId === 'fake-avatar' && fakeAvatarOutputUrl && fakeAvatarProxyUrl ? (() => {
    const output = new URL(fakeAvatarOutputUrl); const proxy = new URL(fakeAvatarProxyUrl);
    return {
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => { const requested = new URL(String(input)); const target = new URL(proxy); target.pathname = requested.pathname; target.search = requested.search; return fetch(target, init); },
      resolveRemoteMedia: async (hostname: string) => hostname === output.hostname ? [{ address: '93.184.216.34', family: 4 as const }] : [],
    };
  })() : undefined;
  const allowedProviderResultHosts = new Set((process.env.CONTENTOS_ALLOW_HZAGENT_RESULT_HOSTS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const providerResultBoundary = allowedProviderResultHosts.size > 0 ? { resolveRemoteMedia: async (hostname: string) => allowedProviderResultHosts.has(hostname.toLowerCase()) ? [{ address: '1.1.1.1', family: 4 as const }] : [] } : undefined;
  // This boundary is only enabled when the explicitly selected fake provider is used by deterministic tests.
  const staging = process.env.CONTENTOS_MEDIA_STAGING_UPLOAD === 'uguu' ? new UguuMediaStaging(assets, storage) : providers.staging;
  const dependencies: DigitalHumanWorkerDependencies = { jobs, digitalHuman: new DigitalHumanService(db, jobs, assets), assets, assetService: new AssetService(db, storage, (path) => probeMedia(path, config.ffprobePath)), probeRemoteResult: (path, signal) => probeMedia(path, config.ffprobePath, signal), storage, speechProvider: providers.speech, avatarProvider: providers.avatar, staging, ...(fakeAvatarBoundary || {}), ...(providerResultBoundary || {}), maxRemoteResultBytes: config.assetUploadMaxBytes, remoteResultTimeoutMs: config.digitalHumanRemoteResultTimeoutMs };
  const runner = createDigitalHumanDevRunner(dependencies, { pollIntervalMs: config.digitalHumanPollIntervalMs, batchSize: config.digitalHumanWorkerConcurrency }); await runner.start();
  const close = async (signal: string) => { await runner.stop(signal); await db.end(); }; process.once('SIGINT', () => { void close('SIGINT'); }); process.once('SIGTERM', () => { void close('SIGTERM'); });
}

if (process.argv[1]?.endsWith('dev-main.ts')) await startLocalWorker();
