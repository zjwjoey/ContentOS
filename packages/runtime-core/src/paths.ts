import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuntimePaths { appRoot: string; runtimeRoot: string; stateRoot: string; logsRoot: string; startupReportsRoot: string; configRoot: string; storageRoot: string; }

export function resolveRuntimePaths(env: Record<string, string | undefined> = process.env): RuntimePaths {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const appRoot = resolve(env.CONTENTOS_APP_ROOT?.trim() || packageRoot);
  const runtimeRoot = resolve(env.CONTENTOS_RUNTIME_ROOT?.trim() || resolve(appRoot, 'runtime'));
  return {
    appRoot,
    runtimeRoot,
    stateRoot: resolve(runtimeRoot, 'state'),
    logsRoot: resolve(runtimeRoot, 'logs'),
    startupReportsRoot: resolve(runtimeRoot, 'startup-reports'),
    configRoot: resolve(env.CONTENTOS_CONFIG_ROOT?.trim() || resolve(appRoot, 'config')),
    storageRoot: resolve(env.STORAGE_ROOT?.trim() || resolve(appRoot, 'storage', 'local')),
  };
}
