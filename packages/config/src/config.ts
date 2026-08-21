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
  publisherWorkerConcurrency: number;
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

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV || 'development') as Environment;
  if (!['development', 'test', 'staging', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV is invalid');
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
    publisherWorkerConcurrency: integer(env, 'PUBLISHER_WORKER_CONCURRENCY', 1),
  };
}
