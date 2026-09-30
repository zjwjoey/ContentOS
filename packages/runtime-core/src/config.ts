import { resolveRuntimePaths, type RuntimePaths } from './paths.js';

export type RuntimeLaunchMode = 'DEVELOPMENT' | 'PACKAGED';

export interface RuntimeConfig extends RuntimePaths {
  databaseUrl: string;
  databaseMode: 'EXTERNAL' | 'EMBEDDED';
  databasePort: number;
  databaseUser: string;
  databasePassword: string;
  databaseName: string;
  apiPort: number;
  webPort: number;
  controlPort: number;
  launchMode: RuntimeLaunchMode;
}

const DEFAULT_DATABASE_URL = 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_operator_dev';

export function resolveRuntimeConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const paths = resolveRuntimePaths(env);
  const mode = env.CONTENTOS_RUNTIME_MODE?.trim().toUpperCase() === 'PACKAGED' ? 'PACKAGED' : 'DEVELOPMENT';
  const databaseMode = ['EMBEDDED', 'BUNDLED'].includes(env.CONTENTOS_DATABASE_MODE?.trim().toUpperCase() || '') ? 'EMBEDDED' : 'EXTERNAL';
  const databasePort = Number(env.CONTENTOS_DATABASE_PORT || 55433);
  const databaseUser = env.CONTENTOS_DATABASE_USER?.trim() || 'contentos';
  const databasePassword = env.CONTENTOS_DATABASE_PASSWORD || 'contentos-local';
  const databaseName = env.CONTENTOS_DATABASE_NAME?.trim() || 'contentos';
  return {
    ...paths,
    databaseUrl: env.DATABASE_URL?.trim() || (databaseMode === 'EMBEDDED' ? `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(databasePassword)}@127.0.0.1:${databasePort}/${encodeURIComponent(databaseName)}` : DEFAULT_DATABASE_URL),
    databaseMode,
    databasePort,
    databaseUser,
    databasePassword,
    databaseName,
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
    CONTENTOS_USER_DATA_ROOT: config.userDataRoot,
    CONTENTOS_CONFIG_ROOT: config.configRoot,
    CONTENTOS_LOGS_ROOT: config.logsRoot,
    STORAGE_ROOT: config.storageRoot,
    CONTENTOS_DATABASE_ROOT: config.databaseRoot,
    CONTENTOS_CACHE_ROOT: config.cacheRoot,
    CONTENTOS_TEMP_ROOT: config.tempRoot,
    CONTENTOS_RESOURCES_ROOT: config.resourcesRoot,
    CONTENTOS_DATABASE_MODE: config.databaseMode,
    CONTENTOS_DATABASE_PORT: String(config.databasePort),
    CONTENTOS_DATABASE_USER: config.databaseUser,
    CONTENTOS_DATABASE_PASSWORD: config.databasePassword,
    CONTENTOS_DATABASE_NAME: config.databaseName,
    DATABASE_URL: config.databaseUrl,
    PORT: String(config.apiPort),
    WEB_PORT: String(config.webPort),
    CONTENTOS_RUNTIME_CONTROL_PORT: String(config.controlPort),
    CONTENTOS_RUNTIME_MODE: config.launchMode,
  };
}
