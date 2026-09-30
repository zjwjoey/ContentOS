import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

export interface RuntimePaths {
  appRoot: string;
  userDataRoot: string;
  runtimeRoot: string;
  stateRoot: string;
  logsRoot: string;
  startupReportsRoot: string;
  configRoot: string;
  storageRoot: string;
  databaseRoot: string;
  cacheRoot: string;
  tempRoot: string;
  resourcesRoot: string;
}

export function findContentOsRoot(startPath = dirname(fileURLToPath(import.meta.url))): string {
  let current = resolve(startPath);
  for (let depth = 0; depth < 10; depth += 1) {
    const manifest = resolve(current, 'package.json');
    if (existsSync(manifest) && existsSync(resolve(current, 'pnpm-workspace.yaml'))) {
      try {
        const packageJson = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
        if (packageJson.name === 'contentos') return current;
      } catch { /* continue walking when a parent manifest is unreadable */ }
    }
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function resolveRuntimePaths(env: Record<string, string | undefined> = process.env): RuntimePaths {
  const packageRoot = findContentOsRoot();
  const appRoot = resolve(env.CONTENTOS_APP_ROOT?.trim() || packageRoot);
  const desktopUserData = env.CONTENTOS_USER_DATA_ROOT?.trim();
  const userDataRoot = resolve(desktopUserData || resolve(appRoot, 'runtime'));
  const runtimeRoot = resolve(env.CONTENTOS_RUNTIME_ROOT?.trim() || resolve(userDataRoot, 'runtime'));
  return {
    appRoot,
    userDataRoot,
    runtimeRoot,
    stateRoot: resolve(runtimeRoot, 'state'),
    logsRoot: resolve(env.CONTENTOS_LOGS_ROOT?.trim() || (desktopUserData ? resolve(userDataRoot, 'logs') : resolve(runtimeRoot, 'logs'))),
    startupReportsRoot: resolve(runtimeRoot, 'startup-reports'),
    configRoot: resolve(env.CONTENTOS_CONFIG_ROOT?.trim() || (desktopUserData ? resolve(userDataRoot, 'config') : resolve(appRoot, 'config'))),
    storageRoot: resolve(env.STORAGE_ROOT?.trim() || (desktopUserData ? resolve(userDataRoot, 'storage') : resolve(appRoot, 'storage', 'local'))),
    databaseRoot: resolve(env.CONTENTOS_DATABASE_ROOT?.trim() || resolve(userDataRoot, 'data', 'postgres')),
    cacheRoot: resolve(env.CONTENTOS_CACHE_ROOT?.trim() || resolve(userDataRoot, 'cache')),
    tempRoot: resolve(env.CONTENTOS_TEMP_ROOT?.trim() || resolve(userDataRoot, 'temp')),
    resourcesRoot: resolve(env.CONTENTOS_RESOURCES_ROOT?.trim() || resolve(appRoot, 'resources')),
  };
}
