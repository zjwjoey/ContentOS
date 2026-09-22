export type Environment = 'development' | 'test' | 'staging' | 'production';

export interface AppConfig {
  nodeEnv: Environment;
  port: number;
  databaseUrl: string;
  storageRoot: string;
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegFontFile: string;
  logLevel: string;
  videoWorkerConcurrency: number;
  assetWorkerConcurrency: number;
  assetUploadMaxBytes: number;
  assetUploadStagingRoot: string;
  publisherWorkerConcurrency: number;
  publisherRealAdaptersEnabled: boolean;
  publisherWechatAllowSubmit: boolean;
  publisherWechatHeaded: boolean;
  publisherProfileRoot: string;
  publisherEvidenceRoot: string;
  digitalHumanWorkerConcurrency: number;
  digitalHumanPollIntervalMs: number;
  digitalHumanSpeechProvider: string;
  indexttsBaseUrl: string;
  digitalHumanAvatarProvider: string;
  mediaStagingProvider: string;
  mediaStagingBaseUrl: string;
  mediaStagingSecret: string;
  digitalHumanProviderRequestTimeoutMs: number;
  digitalHumanProviderCapabilityTimeoutMs: number;
  digitalHumanRemoteResultTimeoutMs: number;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function integer(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
}

function flag(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined) return fallback;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`${key} must be 0, 1, true or false`);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV || 'development') as Environment;
  if (!['development', 'test', 'staging', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV is invalid');
  const publisherRealAdaptersEnabled = flag(env, 'PUBLISHER_REAL_ADAPTERS_ENABLED', false);
  const publisherWechatAllowSubmit = flag(env, 'PUBLISHER_WECHAT_ALLOW_SUBMIT', false);
  if (publisherWechatAllowSubmit && !publisherRealAdaptersEnabled) throw new Error('Real adapters are disabled; PUBLISHER_WECHAT_ALLOW_SUBMIT cannot be enabled');
  return {
    nodeEnv,
    port: integer(env, 'PORT', 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    storageRoot: required(env, 'STORAGE_ROOT'),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    ffmpegFontFile: env.FFMPEG_FONT_FILE || 'C:\\Windows\\Fonts\\msyh.ttc',
    logLevel: env.LOG_LEVEL || 'info',
    videoWorkerConcurrency: integer(env, 'VIDEO_WORKER_CONCURRENCY', 1),
    assetWorkerConcurrency: integer(env, 'ASSET_WORKER_CONCURRENCY', 1),
    assetUploadMaxBytes: integer(env, 'ASSET_UPLOAD_MAX_BYTES', 500 * 1024 * 1024),
    assetUploadStagingRoot: env.ASSET_UPLOAD_STAGING_ROOT || 'storage/staging',
    publisherWorkerConcurrency: integer(env, 'PUBLISHER_WORKER_CONCURRENCY', 1),
    publisherRealAdaptersEnabled,
    publisherWechatAllowSubmit,
    publisherWechatHeaded: flag(env, 'PUBLISHER_WECHAT_HEADED', true),
    publisherProfileRoot: env.PUBLISHER_PROFILE_ROOT || 'storage/publisher-profiles',
    publisherEvidenceRoot: env.PUBLISHER_EVIDENCE_ROOT || 'artifacts/publisher',
    digitalHumanWorkerConcurrency: integer(env, 'DIGITAL_HUMAN_WORKER_CONCURRENCY', 1),
    digitalHumanPollIntervalMs: integer(env, 'DIGITAL_HUMAN_POLL_INTERVAL_MS', 250),
    digitalHumanSpeechProvider: env.CONTENTOS_SPEECH_PROVIDER || 'indextts25',
    indexttsBaseUrl: env.CONTENTOS_INDEXTTS_BASE_URL || 'http://127.0.0.1:8788',
    digitalHumanAvatarProvider: env.CONTENTOS_AVATAR_PROVIDER || 'hzagent',
    mediaStagingProvider: env.CONTENTOS_MEDIA_STAGING_PROVIDER || 'signed-url',
    mediaStagingBaseUrl: env.CONTENTOS_MEDIA_STAGING_BASE_URL || '',
    mediaStagingSecret: env.CONTENTOS_MEDIA_STAGING_SECRET || '',
    // Local IndexTTS can take well over 30 seconds for a long script or on its
    // first CUDA request. Keep the request bounded, but give normal long-form
    // speech generation enough time to finish without being cancelled by the
    // worker's HTTP timeout.
    digitalHumanProviderRequestTimeoutMs: integer(env, 'CONTENTOS_PROVIDER_REQUEST_TIMEOUT_MS', 180_000),
    digitalHumanProviderCapabilityTimeoutMs: integer(env, 'CONTENTOS_PROVIDER_CAPABILITY_TIMEOUT_MS', 5_000),
    digitalHumanRemoteResultTimeoutMs: integer(env, 'CONTENTOS_AVATAR_RESULT_TIMEOUT_MS', 300_000),
  };
}
