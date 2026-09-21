import { access, constants, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Pool } from 'pg';

export type LocalPathPurpose = 'MEDIA_ROOT' | 'OUTPUT_ROOT' | 'MUSIC_ROOT' | 'VOICE_FILE' | 'MUSIC_FILE' | 'PRIORITY_ASSET' | 'JIANYING_DRAFT';
export type LocalPathGrantKind = 'MEDIA_ROOT' | 'OUTPUT_ROOT' | 'VOICE_FILE' | 'MUSIC_ROOT' | 'PRIORITY_ASSET' | 'JIANYING_DRAFT';
export type LocalPathGrantMode = 'READ' | 'WRITE' | 'READ_WRITE';

export interface LocalPathGrant {
  id: string;
  path: string;
  canonicalPath: string;
  kind: LocalPathGrantKind;
  mode: LocalPathGrantMode;
  source: 'NATIVE_PICKER' | 'ENV';
  createdAt: string;
  lastUsedAt: string;
}

export interface NativePathPicker {
  pickFolder(options?: { purpose?: LocalPathPurpose }): Promise<{ cancelled: true } | { cancelled: false; path: string }>;
  pickFile(options?: { purpose?: LocalPathPurpose; filters?: Array<{ name: string; extensions: string[] }> }): Promise<{ cancelled: true } | { cancelled: false; path: string }>;
}

export class UnsupportedNativePathPicker implements NativePathPicker {
  async pickFolder(): Promise<{ cancelled: true }> { return { cancelled: true }; }
  async pickFile(): Promise<{ cancelled: true }> { return { cancelled: true }; }
}

function contains(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.toLocaleLowerCase() === root.toLocaleLowerCase() || candidate.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase());
}

function envRoots(key: string): string[] {
  return (process.env[key] || '').split(';').map((value) => value.trim()).filter(Boolean).map((value) => resolve(value));
}

function envKey(kind: LocalPathGrantKind): string {
  if (kind === 'OUTPUT_ROOT') return 'CONTENTOS_OUTPUT_ROOTS';
  if (kind === 'MUSIC_ROOT') return 'CONTENTOS_MUSIC_ROOTS';
  return 'CONTENTOS_LOCAL_MEDIA_ROOTS';
}

function purposeKind(purpose: LocalPathPurpose): { kind: LocalPathGrantKind; mode: LocalPathGrantMode; file: boolean; either?: boolean } {
  if (purpose === 'OUTPUT_ROOT') return { kind: 'OUTPUT_ROOT', mode: 'WRITE', file: false };
  if (purpose === 'MUSIC_ROOT') return { kind: 'MUSIC_ROOT', mode: 'READ', file: false };
  if (purpose === 'VOICE_FILE') return { kind: 'VOICE_FILE', mode: 'READ', file: true };
  if (purpose === 'MUSIC_FILE') return { kind: 'VOICE_FILE', mode: 'READ', file: true };
  if (purpose === 'PRIORITY_ASSET') return { kind: 'PRIORITY_ASSET', mode: 'READ', file: true };
  if (purpose === 'JIANYING_DRAFT') return { kind: 'JIANYING_DRAFT', mode: 'READ', file: false, either: true };
  return { kind: 'MEDIA_ROOT', mode: 'READ', file: false };
}

export interface LocalPathAccessServiceOptions { db: Pool; desktopMode?: boolean; }

/**
 * Canonical, persisted access grants for local desktop paths. Environment
 * allowlists remain a deployment fallback; native-picker grants are durable
 * and take precedence for the local desktop workflow.
 */
export class LocalPathAccessService {
  readonly desktopMode: boolean;
  constructor(private readonly options: LocalPathAccessServiceOptions) {
    this.desktopMode = options.desktopMode ?? process.env.CONTENTOS_LOCAL_DESKTOP_MODE !== '0';
  }

  async canonicalize(input: string): Promise<string> {
    if (!input || input.includes('\0')) throw new Error('LOCAL_PATH_INVALID');
    const candidate = await realpath(resolve(input)).catch(() => null);
    if (!candidate) throw new Error('LOCAL_PATH_NOT_FOUND');
    return candidate;
  }

  async inspect(path: string): Promise<{ canonicalPath: string; isFile: boolean; isDirectory: boolean; readable: boolean; writable: boolean }> {
    const canonicalPath = await this.canonicalize(path);
    const details = await stat(canonicalPath).catch(() => null);
    if (!details) throw new Error('LOCAL_PATH_NOT_FOUND');
    const [readable, writable] = await Promise.all([
      access(canonicalPath, constants.R_OK).then(() => true).catch(() => false),
      access(canonicalPath, constants.W_OK).then(() => true).catch(() => false),
    ]);
    return { canonicalPath, isFile: details.isFile(), isDirectory: details.isDirectory(), readable, writable };
  }

  async grantPath(input: { path: string; purpose: LocalPathPurpose; source?: 'NATIVE_PICKER' | 'ENV' }): Promise<LocalPathGrant> {
    const policy = purposeKind(input.purpose);
    const inspected = await this.inspect(input.path);
    if (!policy.either && (policy.file ? !inspected.isFile : !inspected.isDirectory)) throw new Error(policy.file ? 'LOCAL_PATH_FILE_REQUIRED' : 'LOCAL_PATH_DIRECTORY_REQUIRED');
    if (policy.mode !== 'WRITE' && !inspected.readable) throw new Error('LOCAL_PATH_NOT_READABLE');
    if (policy.mode === 'WRITE' && !inspected.writable) throw new Error('LOCAL_PATH_NOT_WRITABLE');
    const source = input.source || 'NATIVE_PICKER';
    const result = await this.options.db.query<{ id: string; path: string; canonical_path: string; kind: LocalPathGrantKind; mode: LocalPathGrantMode; source: 'NATIVE_PICKER' | 'ENV'; created_at: string; last_used_at: string }>(
      `insert into local_path_grants (path, canonical_path, kind, mode, source, last_used_at)
       values ($1,$2,$3,$4,$5,now())
       on conflict (canonical_path, kind) do update set path=excluded.path, mode=excluded.mode, source=excluded.source, last_used_at=now()
       returning id::text, path, canonical_path, kind, mode, source, created_at::text, last_used_at::text`,
      [input.path, inspected.canonicalPath, policy.kind, policy.mode, source],
    );
    return this.toGrant(result.rows[0]!);
  }

  async authorize(path: string, purpose: LocalPathPurpose): Promise<string> {
    const policy = purposeKind(purpose);
    const inspected = await this.inspect(path);
    if (policy.file ? !inspected.isFile : !inspected.isDirectory) throw new Error(policy.file ? 'LOCAL_PATH_FILE_REQUIRED' : 'LOCAL_PATH_DIRECTORY_REQUIRED');
    const grants = await this.options.db.query<{ id: string; canonical_path: string; kind: LocalPathGrantKind; mode: LocalPathGrantMode }>(
      'select id::text, canonical_path, kind, mode from local_path_grants where kind=$1 or ($2=true and kind in (\'MEDIA_ROOT\',\'MUSIC_ROOT\',\'OUTPUT_ROOT\'))',
      [policy.kind, policy.kind === 'VOICE_FILE' || policy.kind === 'PRIORITY_ASSET' || policy.kind === 'JIANYING_DRAFT'],
    );
    const granted = (await Promise.all(grants.rows.map(async (grant) => {
      const exactFile = (policy.file || policy.either) && grant.kind === policy.kind && grant.canonical_path.toLocaleLowerCase() === inspected.canonicalPath.toLocaleLowerCase();
      const grantStat = await stat(grant.canonical_path).catch(() => null);
      const folderKind = grantStat?.isDirectory() && (grant.kind === policy.kind || (policy.file && (grant.kind === 'MEDIA_ROOT' || (purpose === 'MUSIC_FILE' && grant.kind === 'MUSIC_ROOT'))) || (!policy.file && grant.kind === 'MEDIA_ROOT' && (policy.kind === 'MEDIA_ROOT' || policy.kind === 'JIANYING_DRAFT')));
      const modeAllowed = policy.mode === 'WRITE' ? (grant.mode === 'WRITE' || grant.mode === 'READ_WRITE') : grant.mode === 'READ' || grant.mode === 'READ_WRITE';
      return modeAllowed && (exactFile || (folderKind && contains(grant.canonical_path, inspected.canonicalPath)));
    }))).some(Boolean);
    const envAllowed = await this.authorizedByEnvironment(inspected.canonicalPath, policy, purpose);
    if (!granted && !envAllowed) {
      if (!inspected.readable) throw new Error('LOCAL_PATH_NOT_READABLE');
      if (policy.mode === 'WRITE' && !inspected.writable) throw new Error('LOCAL_PATH_NOT_WRITABLE');
      throw new Error('LOCAL_PATH_NOT_GRANTED');
    }
    await this.options.db.query('update local_path_grants set last_used_at=now() where canonical_path=$1', [inspected.canonicalPath]).catch(() => undefined);
    return inspected.canonicalPath;
  }

  async list(): Promise<LocalPathGrant[]> {
    const result = await this.options.db.query<{ id: string; path: string; canonical_path: string; kind: LocalPathGrantKind; mode: LocalPathGrantMode; source: 'NATIVE_PICKER' | 'ENV'; created_at: string; last_used_at: string }>('select id::text,path,canonical_path,kind,mode,source,created_at::text,last_used_at::text from local_path_grants order by last_used_at desc');
    return result.rows.map((row) => this.toGrant(row));
  }

  private async authorizedByEnvironment(candidate: string, policy: { kind: LocalPathGrantKind; mode: LocalPathGrantMode; file: boolean; either?: boolean }, purpose: LocalPathPurpose): Promise<boolean> {
    const roots = await Promise.all(envRoots(purpose === 'MUSIC_FILE' ? 'CONTENTOS_MUSIC_ROOTS' : envKey(policy.kind)).map((root) => realpath(root).catch(() => null)));
    if (!roots.some((root) => root && (policy.either || policy.file ? root.toLocaleLowerCase() === candidate.toLocaleLowerCase() || contains(root, candidate) : contains(root, candidate)))) return false;
    if (policy.mode === 'WRITE') return (await access(candidate, constants.W_OK).then(() => true).catch(() => false));
    return (await access(candidate, constants.R_OK).then(() => true).catch(() => false));
  }

  private toGrant(row: { id: string; path: string; canonical_path: string; kind: LocalPathGrantKind; mode: LocalPathGrantMode; source: 'NATIVE_PICKER' | 'ENV'; created_at: string; last_used_at: string }): LocalPathGrant {
    return { id: String(row.id), path: row.path, canonicalPath: row.canonical_path, kind: row.kind, mode: row.mode, source: row.source, createdAt: row.created_at, lastUsedAt: row.last_used_at };
  }
}
