import { resolveRuntimePaths, type RuntimePaths } from './paths.js';

export type RuntimeLaunchMode = 'DEVELOPMENT' | 'PACKAGED';

export interface RuntimeConfig extends RuntimePaths {
  databaseUrl: string;
  apiPort: number;
  webPort: number;
  controlPort: number;
  launchMode: RuntimeLaunchMode;
}

const DEFAULT_DATABASE_URL = 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_operator_dev';

export function resolveRuntimeConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const paths = resolveRuntimePaths(env);
  const mode = env.CONTENTOS_RUNTIME_MODE?.trim().toUpperCase() === 'PACKAGED' ? 'PACKAGED' : 'DEVELOPMENT';
  return {
    ...paths,
    databaseUrl: env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL,
    apiPort: Number(env.PORT || 3000),
    webPort: Number(env.WEB_PORT || 3001),
    controlPort: Number(env.CONTENTOS_RUNTIME_CONTROL_PORT || 3099),
    launchMode: mode,
  };
}

export function runtimeConfigEnv(config: RuntimeConfig, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return {
    ...env,
    CONTENTOS_APP_ROOT: config.appRoot,
    CONTENTOS_RUNTIME_ROOT: config.runtimeRoot,
    CONTENTOS_CONFIG_ROOT: config.configRoot,
    STORAGE_ROOT: config.storageRoot,
    DATABASE_URL: config.databaseUrl,
    PORT: String(config.apiPort),
    WEB_PORT: String(config.webPort),
    CONTENTOS_RUNTIME_CONTROL_PORT: String(config.controlPort),
    CONTENTOS_RUNTIME_MODE: config.launchMode,
  };
}
