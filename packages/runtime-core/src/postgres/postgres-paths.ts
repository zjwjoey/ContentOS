import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface PostgresResourcePaths {
  root: string;
  binRoot: string;
  libRoot: string;
  shareRoot: string;
  postgres: string;
  pgCtl: string;
  initdb: string;
}

export function resolvePostgresResourcePaths(resourcesRoot: string): PostgresResourcePaths {
  const root = resolve(resourcesRoot, 'postgres');
  const binRoot = resolve(root, 'bin');
  const extension = process.platform === 'win32' ? '.exe' : '';
  return {
    root,
    binRoot,
    libRoot: resolve(root, 'lib'),
    shareRoot: resolve(root, 'share'),
    postgres: resolve(binRoot, `postgres${extension}`),
    pgCtl: resolve(binRoot, `pg_ctl${extension}`),
    initdb: resolve(binRoot, `initdb${extension}`),
  };
}

export async function assertPostgresResources(paths: PostgresResourcePaths): Promise<void> {
  for (const [name, file] of Object.entries({ postgres: paths.postgres, pg_ctl: paths.pgCtl, initdb: paths.initdb })) {
    try { await access(file); }
    catch { throw Object.assign(new Error(`PostgreSQL resource missing: ${name}`), { code: 'POSTGRES_BINARY_MISSING', path: file }); }
  }
  for (const [name, directory] of Object.entries({ lib: paths.libRoot, share: paths.shareRoot })) {
    try { await access(directory); }
    catch { throw Object.assign(new Error(`PostgreSQL resource directory missing: ${name}`), { code: 'POSTGRES_RESOURCE_MISSING', path: directory }); }
  }
}
