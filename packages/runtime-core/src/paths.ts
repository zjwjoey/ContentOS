import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

export interface RuntimePaths { appRoot: string; runtimeRoot: string; stateRoot: string; logsRoot: string; startupReportsRoot: string; configRoot: string; storageRoot: string; }

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
