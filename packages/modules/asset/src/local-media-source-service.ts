import { readdir, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { probeMedia, type ProbeResult } from '../../../infrastructure/ffmpeg/src/index.js';
import type { Pool } from 'pg';

export const LOCAL_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

export interface LocalMediaAsset {
  fileName: string;
  relativePath: string;
  durationMs: number;
  width: number;
  height: number;
  format: string;
  codec?: string;
  available: boolean;
  errorMessage?: string;
  /** Internal absolute path used only by the planner/renderer, never by the public mapper. */
  sourcePath: string;
}

export interface LocalMediaScanResult {
  sourceRootId: string;
  files: LocalMediaAsset[];
  totalCount: number;
  availableCount: number;
  unavailableCount: number;
}

export interface LocalMediaSourceOptions {
  allowedRoots?: string[];
  ffprobePath?: string;
  probe?: (path: string) => Promise<ProbeResult>;
  db?: Pool;
}

function normalizedRoots(roots: string[]): string[] { return [...new Set(roots.map((root) => resolve(root.trim())).filter(Boolean))]; }
function contains(root: string, candidate: string): boolean { const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`; return candidate.toLowerCase() === root.toLowerCase() || candidate.toLowerCase().startsWith(rootWithSep.toLowerCase()); }
function publicRootId(root: string): string { return `local-${Buffer.from(root.toLowerCase()).toString('base64url').slice(0, 18)}`; }

/**
 * Safe reference scanner for user-authorized local media folders. It never
 * accepts a path outside the configured roots and never follows symlinks.
 */
export class LocalMediaSourceService {
  private readonly roots: string[];
  private readonly ffprobePath: string;
  private readonly probe: (path: string) => Promise<ProbeResult>;
  private readonly db: Pool | undefined;

  constructor(options: LocalMediaSourceOptions = {}) {
    this.roots = normalizedRoots(options.allowedRoots ?? (process.env.CONTENTOS_LOCAL_MEDIA_ROOTS || '').split(';').filter(Boolean));
    this.ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
    this.probe = options.probe || ((path) => probeMedia(path, this.ffprobePath));
    this.db = options.db;
  }

  authorizeRoot(input: string): { root: string; sourceRootId: string } {
    if (!input || input.includes('\0')) throw new Error('LOCAL_MEDIA_ROOT_INVALID');
    const root = resolve(input);
    const authorized = this.roots.find((candidate) => contains(candidate, root));
    if (!authorized) throw new Error('LOCAL_MEDIA_ROOT_UNAUTHORIZED');
    return { root, sourceRootId: publicRootId(root) };
  }

  async scan(input: { sourceRoot: string; recursive?: boolean; onProgress?: (progress: { discovered: number; analyzed: number }) => Promise<void> | void; signal?: AbortSignal }): Promise<LocalMediaScanResult> {
    const { root, sourceRootId } = this.authorizeRoot(input.sourceRoot);
    const rootStat = await stat(root).catch(() => null);
    if (!rootStat?.isDirectory()) throw new Error('LOCAL_MEDIA_ROOT_NOT_FOUND');
    const files: LocalMediaAsset[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (input.signal?.aborted) throw new Error('LOCAL_MEDIA_SCAN_CANCELLED');
        if (entry.isSymbolicLink()) continue;
        const fullPath = resolve(directory, entry.name);
        if (entry.isDirectory()) { if (input.recursive !== false) await visit(fullPath); continue; }
        if (!entry.isFile() || !LOCAL_VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
        await input.onProgress?.({ discovered: files.length + 1, analyzed: files.length });
        const relativePath = relative(root, fullPath).split(/[\\/]+/gu).join('/');
        try {
          const metadata = await this.probe(fullPath);
          const available = metadata.width > 0 && metadata.durationMs > 0;
          files.push({ fileName: basename(fullPath), relativePath, durationMs: metadata.durationMs, width: metadata.width, height: metadata.height, format: metadata.format, ...(metadata.videoCodec ? { codec: metadata.videoCodec } : {}), available, ...(available ? {} : { errorMessage: '无法读取视频元数据' }), sourcePath: fullPath });
        } catch (error) {
          files.push({ fileName: basename(fullPath), relativePath, durationMs: 0, width: 0, height: 0, format: extname(entry.name).slice(1), available: false, errorMessage: error instanceof Error ? error.message.slice(0, 200) : '无法读取视频', sourcePath: fullPath });
        }
        await input.onProgress?.({ discovered: files.length, analyzed: files.length });
      }
    };
    await visit(root);
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { sourceRootId, files, totalCount: files.length, availableCount: files.filter((file) => file.available).length, unavailableCount: files.filter((file) => !file.available).length };
  }

  async createScan(input: { id: string; projectId: string; sourceRoot: string; recursive: boolean; sourceRootId?: string }): Promise<void> {
    if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED');
    const authorized = this.authorizeRoot(input.sourceRoot);
    await this.db.query('insert into local_media_scans (id, project_id, source_root, source_root_id, recursive, status) values ($1, $2, $3, $4, $5, $6)', [input.id, input.projectId, authorized.root, input.sourceRootId || authorized.sourceRootId, input.recursive, 'QUEUED']);
  }

  async markScanRunning(scanId: string): Promise<void> { if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED'); await this.db.query("update local_media_scans set status = 'RUNNING', updated_at = now() where id = $1 and status = 'QUEUED'", [scanId]); }
  async updateScanProgress(scanId: string, progress: { discovered: number; analyzed: number }): Promise<void> { if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED'); await this.db.query('update local_media_scans set progress = $2, updated_at = now() where id = $1', [scanId, progress]); }

  async completeScan(scanId: string, result: LocalMediaScanResult): Promise<void> {
    if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED');
    const client = await this.db.connect();
    try {
      await client.query('begin');
      await client.query('delete from local_media_scan_files where scan_id = $1', [scanId]);
      for (const file of result.files) {
        const fileId = `${result.sourceRootId}:${file.relativePath}`;
        await client.query('insert into local_media_scan_files (scan_id, file_id, file_name, relative_path, source_path, duration_ms, width, height, format, codec, available, error_message) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [scanId, fileId, file.fileName, file.relativePath, file.sourcePath, Math.round(file.durationMs), file.width, file.height, file.format, file.codec || null, file.available, file.errorMessage || null]);
      }
      await client.query("update local_media_scans set status = 'SUCCEEDED', progress = $2, scanned_at = now(), updated_at = now(), error = null where id = $1", [scanId, { discovered: result.totalCount, analyzed: result.totalCount, available: result.availableCount, unavailable: result.unavailableCount }]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async failScan(scanId: string, error: unknown, status: 'FAILED' | 'CANCELLED' = 'FAILED'): Promise<void> { if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED'); await this.db.query('update local_media_scans set status = $2, error = $3, updated_at = now() where id = $1', [scanId, status, error]); }

  async getScan(scanId: string, projectId?: string): Promise<{ id: string; projectId: string; sourceRootId: string; sourceRoot: string; recursive: boolean; status: string; progress: Record<string, unknown>; error: unknown; files: LocalMediaAsset[] } | null> {
    if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED');
    const row = (await this.db.query('select * from local_media_scans where id = $1 and ($2::text is null or project_id = $2)', [scanId, projectId || null])).rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const files = await this.db.query('select * from local_media_scan_files where scan_id = $1 order by relative_path', [scanId]);
    return { id: String(row.id), projectId: String(row.project_id), sourceRootId: String(row.source_root_id), sourceRoot: String(row.source_root), recursive: Boolean(row.recursive), status: String(row.status), progress: (row.progress || {}) as Record<string, unknown>, error: row.error, files: files.rows.map((file) => ({ fileName: String(file.file_name), relativePath: String(file.relative_path), sourcePath: String(file.source_path), durationMs: Number(file.duration_ms), width: Number(file.width), height: Number(file.height), format: String(file.format), ...(file.codec ? { codec: String(file.codec) } : {}), available: Boolean(file.available), ...(file.error_message ? { errorMessage: String(file.error_message) } : {}) })) };
  }

  async getLatestScan(projectId: string, sourceRootId: string): Promise<Awaited<ReturnType<LocalMediaSourceService['getScan']>>> { if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED'); const row = (await this.db.query("select id from local_media_scans where project_id = $1 and source_root_id = $2 and status = 'SUCCEEDED' order by scanned_at desc nulls last, created_at desc limit 1", [projectId, sourceRootId])).rows[0] as { id?: string } | undefined; return row?.id ? this.getScan(String(row.id), projectId) : null; }

  async getFile(sourceRootId: string, fileId: string, projectId?: string): Promise<LocalMediaAsset | null> {
    if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED');
    const row = (await this.db.query("select f.* from local_media_scan_files f join local_media_scans s on s.id = f.scan_id where s.source_root_id = $1 and f.file_id = $2 and s.status = 'SUCCEEDED' and ($3::text is null or s.project_id = $3) order by s.scanned_at desc nulls last limit 1", [sourceRootId, fileId, projectId || null])).rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return { fileName: String(row.file_name), relativePath: String(row.relative_path), sourcePath: String(row.source_path), durationMs: Number(row.duration_ms), width: Number(row.width), height: Number(row.height), format: String(row.format), ...(row.codec ? { codec: String(row.codec) } : {}), available: Boolean(row.available), ...(row.error_message ? { errorMessage: String(row.error_message) } : {}) };
  }

  /** Strip the internal path before returning scan data from an HTTP handler. */
  static toPublicFile(file: LocalMediaAsset): Omit<LocalMediaAsset, 'sourcePath'> { const { sourcePath: _sourcePath, ...safe } = file; return safe; }
}
