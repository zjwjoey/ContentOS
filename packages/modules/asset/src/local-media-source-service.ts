import { readdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { access as accessFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { generateVideoThumbnail, probeMedia, type ProbeResult } from '../../../infrastructure/ffmpeg/src/index.js';
import type { Pool } from 'pg';

export const LOCAL_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

export interface LocalMediaAsset {
  sourceRootId?: string;
  fileName: string;
  relativePath: string;
  durationMs: number;
  width: number;
  height: number;
  format: string;
  codec?: string;
  orientation: 'VERTICAL' | 'HORIZONTAL' | 'SQUARE' | 'UNKNOWN';
  fileSize?: number;
  modifiedAt?: string;
  tags: string[];
  category?: string;
  usageCount?: number;
  recentUsageCount?: number;
  lastUsedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  thumbnailKey?: string;
  thumbnailStatus?: 'PENDING' | 'READY' | 'FAILED';
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
  thumbnailRoot?: string;
}

function normalizedRoots(roots: string[]): string[] { return [...new Set(roots.map((root) => resolve(root.trim())).filter(Boolean))]; }
function contains(root: string, candidate: string): boolean { const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`; return candidate.toLowerCase() === root.toLowerCase() || candidate.toLowerCase().startsWith(rootWithSep.toLowerCase()); }
function publicRootId(root: string): string { return `local-${Buffer.from(root.toLowerCase()).toString('base64url').slice(0, 18)}`; }
function orientation(width: number, height: number): LocalMediaAsset['orientation'] { if (width <= 0 || height <= 0) return 'UNKNOWN'; if (width / height > 1.05) return 'HORIZONTAL'; if (height / width > 1.05) return 'VERTICAL'; return 'SQUARE'; }
function filenameTags(fileName: string): string[] {
  const stem = basename(fileName, extname(fileName));
  return [...new Set((stem.match(/[A-Z]?[a-z]+|[\u3400-\u9fff]+|\d+/gu) || []).map((tag) => tag.trim()).filter(Boolean))];
}

/**
 * Safe reference scanner for user-authorized local media folders. It never
 * accepts a path outside the configured roots and never follows symlinks.
 */
export class LocalMediaSourceService {
  private readonly roots: string[];
  private readonly ffprobePath: string;
  private readonly probe: (path: string) => Promise<ProbeResult>;
  private readonly db: Pool | undefined;
  private readonly thumbnailRoot: string;

  constructor(options: LocalMediaSourceOptions = {}) {
    this.roots = normalizedRoots(options.allowedRoots ?? (process.env.CONTENTOS_LOCAL_MEDIA_ROOTS || '').split(';').filter(Boolean));
    this.ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
    this.probe = options.probe || ((path) => probeMedia(path, this.ffprobePath));
    this.db = options.db;
    this.thumbnailRoot = resolve(options.thumbnailRoot || join(process.env.STORAGE_ROOT || 'storage', 'thumbnails'));
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
          const fileStat = await stat(fullPath).catch(() => null);
          const available = metadata.width > 0 && metadata.durationMs > 0;
          files.push({ fileName: basename(fullPath), relativePath, durationMs: metadata.durationMs, width: metadata.width, height: metadata.height, format: metadata.format, ...(metadata.videoCodec ? { codec: metadata.videoCodec } : {}), orientation: orientation(metadata.width, metadata.height), ...(fileStat ? { fileSize: fileStat.size, modifiedAt: fileStat.mtime.toISOString() } : {}), tags: filenameTags(basename(fullPath)), available, ...(available ? {} : { errorMessage: '无法读取视频元数据' }), sourcePath: fullPath });
        } catch (error) {
          const fileStat = await stat(fullPath).catch(() => null);
          files.push({ fileName: basename(fullPath), relativePath, durationMs: 0, width: 0, height: 0, format: extname(entry.name).slice(1), orientation: 'UNKNOWN', ...(fileStat ? { fileSize: fileStat.size, modifiedAt: fileStat.mtime.toISOString() } : {}), tags: filenameTags(basename(fullPath)), available: false, errorMessage: error instanceof Error ? error.message.slice(0, 200) : '无法读取视频', sourcePath: fullPath });
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
      const currentFileIds: string[] = [];
      for (const file of result.files) {
        const fileId = `${result.sourceRootId}:${file.relativePath}`;
        currentFileIds.push(fileId);
        await client.query('insert into local_media_scan_files (scan_id, file_id, file_name, relative_path, source_path, duration_ms, width, height, format, codec, available, error_message, orientation, file_size, modified_at, tags, thumbnail_status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)', [scanId, fileId, file.fileName, file.relativePath, file.sourcePath, Math.round(file.durationMs), file.width, file.height, file.format, file.codec || null, file.available, file.errorMessage || null, file.orientation, file.fileSize || null, file.modifiedAt || null, JSON.stringify(file.tags), 'PENDING']);
        await client.query(`insert into local_media_index (file_id, source_root_id, relative_path, file_name, duration_ms, width, height, orientation, format, codec, file_size, modified_at, tags, availability, thumbnail_status)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PENDING')
          on conflict (file_id) do update set file_name = excluded.file_name, duration_ms = excluded.duration_ms, width = excluded.width, height = excluded.height, orientation = excluded.orientation, format = excluded.format, codec = excluded.codec, file_size = excluded.file_size, modified_at = excluded.modified_at, tags = case when local_media_index.tags = excluded.tags then excluded.tags else local_media_index.tags end, availability = excluded.availability, thumbnail_status = case when local_media_index.modified_at is distinct from excluded.modified_at or local_media_index.file_size is distinct from excluded.file_size then 'PENDING' else local_media_index.thumbnail_status end, updated_at = now()`, [fileId, result.sourceRootId, file.relativePath, file.fileName, Math.round(file.durationMs), file.width, file.height, file.orientation, file.format, file.codec || null, file.fileSize || null, file.modifiedAt || null, JSON.stringify(file.tags), file.available ? 'AVAILABLE' : 'UNAVAILABLE']);
      }
      await client.query('update local_media_index set availability = \'MISSING\', updated_at = now() where source_root_id = $1 and file_id <> all($2::text[]) and availability <> \'MISSING\'', [result.sourceRootId, currentFileIds]);
      await client.query("update local_media_scans set status = 'SUCCEEDED', progress = $2, scanned_at = now(), updated_at = now(), error = null where id = $1", [scanId, { discovered: result.totalCount, analyzed: result.totalCount, available: result.availableCount, unavailable: result.unavailableCount }]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async failScan(scanId: string, error: unknown, status: 'FAILED' | 'CANCELLED' = 'FAILED'): Promise<void> { if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED'); await this.db.query('update local_media_scans set status = $2, error = $3, updated_at = now() where id = $1', [scanId, status, error]); }

  async getScan(scanId: string, projectId?: string): Promise<{ id: string; projectId: string; sourceRootId: string; sourceRoot: string; recursive: boolean; status: string; progress: Record<string, unknown>; error: unknown; files: LocalMediaAsset[] } | null> {
    if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED');
    const row = (await this.db.query('select * from local_media_scans where id = $1 and ($2::text is null or project_id = $2)', [scanId, projectId || null])).rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const files = await this.db.query('select f.*, i.tags as index_tags, i.usage_count, i.last_used_at, i.thumbnail_key as index_thumbnail_key, i.thumbnail_status as index_thumbnail_status, i.category as index_category from local_media_scan_files f left join local_media_index i on i.file_id = f.file_id where f.scan_id = $1 order by f.relative_path', [scanId]);
    return { id: String(row.id), projectId: String(row.project_id), sourceRootId: String(row.source_root_id), sourceRoot: String(row.source_root), recursive: Boolean(row.recursive), status: String(row.status), progress: (row.progress || {}) as Record<string, unknown>, error: row.error, files: files.rows.map((file) => ({ fileName: String(file.file_name), relativePath: String(file.relative_path), sourcePath: String(file.source_path), durationMs: Number(file.duration_ms), width: Number(file.width), height: Number(file.height), format: String(file.format), ...(file.codec ? { codec: String(file.codec) } : {}), orientation: (file.orientation || 'UNKNOWN') as LocalMediaAsset['orientation'], ...(file.file_size != null ? { fileSize: Number(file.file_size) } : {}), ...(file.modified_at ? { modifiedAt: new Date(String(file.modified_at)).toISOString() } : {}), tags: Array.isArray(file.index_tags) ? file.index_tags as string[] : Array.isArray(file.tags) ? file.tags as string[] : [], usageCount: Number(file.usage_count || 0), ...(file.last_used_at ? { lastUsedAt: new Date(String(file.last_used_at)).toISOString() } : {}), ...(file.index_category ? { category: String(file.index_category) } : {}), ...(file.index_thumbnail_key ? { thumbnailKey: String(file.index_thumbnail_key) } : {}), ...(file.index_thumbnail_status ? { thumbnailStatus: file.index_thumbnail_status as LocalMediaAsset['thumbnailStatus'] } : file.thumbnail_status ? { thumbnailStatus: file.thumbnail_status as LocalMediaAsset['thumbnailStatus'] } : {}), available: Boolean(file.available), ...(file.error_message ? { errorMessage: String(file.error_message) } : {}) }) as LocalMediaAsset) };
  }

  async getLatestScan(projectId: string, sourceRootId: string): Promise<Awaited<ReturnType<LocalMediaSourceService['getScan']>>> { if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED'); const row = (await this.db.query("select id from local_media_scans where project_id = $1 and source_root_id = $2 and status = 'SUCCEEDED' order by scanned_at desc nulls last, created_at desc limit 1", [projectId, sourceRootId])).rows[0] as { id?: string } | undefined; return row?.id ? this.getScan(String(row.id), projectId) : null; }

  async getFile(sourceRootId: string, fileId: string, projectId?: string): Promise<LocalMediaAsset | null> {
    if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED');
    const row = (await this.db.query("select f.* from local_media_scan_files f join local_media_scans s on s.id = f.scan_id where s.source_root_id = $1 and f.file_id = $2 and s.status = 'SUCCEEDED' and ($3::text is null or s.project_id = $3) order by s.scanned_at desc nulls last limit 1", [sourceRootId, fileId, projectId || null])).rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return ({ fileName: String(row.file_name), relativePath: String(row.relative_path), sourcePath: String(row.source_path), durationMs: Number(row.duration_ms), width: Number(row.width), height: Number(row.height), format: String(row.format), ...(row.codec ? { codec: String(row.codec) } : {}), orientation: (row.orientation || 'UNKNOWN') as LocalMediaAsset['orientation'], ...(row.file_size != null ? { fileSize: Number(row.file_size) } : {}), ...(row.modified_at ? { modifiedAt: new Date(String(row.modified_at)).toISOString() } : {}), tags: Array.isArray(row.tags) ? row.tags as string[] : [], ...(row.category ? { category: String(row.category) } : {}), ...(row.thumbnail_key ? { thumbnailKey: String(row.thumbnail_key) } : {}), ...(row.thumbnail_status ? { thumbnailStatus: row.thumbnail_status as LocalMediaAsset['thumbnailStatus'] } : {}), available: Boolean(row.available), ...(row.error_message ? { errorMessage: String(row.error_message) } : {}) } as LocalMediaAsset);
  }

  async listIndex(projectId: string, filters: { query?: string; orientation?: LocalMediaAsset['orientation'] | 'ALL'; category?: string; usage?: 'ALL' | 'UNUSED' | 'RECENT' | 'FREQUENT'; sort?: 'NAME' | 'UPDATED' | 'DURATION' | 'USAGE' | 'RECENT' } = {}): Promise<LocalMediaAsset[]> {
    if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED');
    const params: unknown[] = [projectId]; const clauses = ["s.status = 'SUCCEEDED'", 's.project_id = $1', "i.availability <> 'MISSING'"]; const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
    if (filters.query?.trim()) { const key = add(`%${filters.query.trim()}%`); clauses.push(`(i.file_name ilike ${key} or i.relative_path ilike ${key} or exists (select 1 from jsonb_array_elements_text(i.tags) tag where tag ilike ${key}))`); }
    if (filters.orientation && filters.orientation !== 'ALL') clauses.push(`i.orientation = ${add(filters.orientation)}`);
    if (filters.category) clauses.push(`i.category = ${add(filters.category)}`);
    if (filters.usage === 'UNUSED') clauses.push('i.usage_count = 0');
    if (filters.usage === 'RECENT') clauses.push("i.last_used_at is not null and i.last_used_at > now() - interval '30 days'");
    if (filters.usage === 'FREQUENT') clauses.push('i.usage_count >= 3');
    const order = filters.sort === 'DURATION' ? 'i.duration_ms desc' : filters.sort === 'USAGE' ? 'i.usage_count desc, i.file_name asc' : filters.sort === 'RECENT' ? 'i.last_used_at desc nulls last, i.file_name asc' : filters.sort === 'UPDATED' ? 'i.updated_at desc' : 'i.file_name asc';
    const result = await this.db.query(`select distinct on (i.file_id) i.*, f.source_path, (select count(*) from local_media_usage u where u.media_id = i.file_id and u.render_id in (select recent.render_id from local_media_usage recent group by recent.render_id order by max(recent.used_at) desc limit 10))::int as recent_usage_count from local_media_index i join local_media_scan_files f on f.file_id = i.file_id join local_media_scans s on s.id = f.scan_id where ${clauses.join(' and ')} order by i.file_id, s.scanned_at desc nulls last, ${order}` , params);
    return result.rows.map((row) => ({ fileName: String(row.file_name), relativePath: String(row.relative_path), sourcePath: String(row.source_path), durationMs: Number(row.duration_ms), width: Number(row.width), height: Number(row.height), orientation: row.orientation as LocalMediaAsset['orientation'], format: String(row.format), ...(row.codec ? { codec: String(row.codec) } : {}), ...(row.file_size != null ? { fileSize: Number(row.file_size) } : {}), ...(row.modified_at ? { modifiedAt: new Date(String(row.modified_at)).toISOString() } : {}), tags: Array.isArray(row.tags) ? row.tags as string[] : [], ...(row.category ? { category: String(row.category) } : {}), usageCount: Number(row.usage_count || 0), recentUsageCount: Number(row.recent_usage_count || 0), ...(row.last_used_at ? { lastUsedAt: new Date(String(row.last_used_at)).toISOString() } : {}), ...(row.created_at ? { createdAt: new Date(String(row.created_at)).toISOString() } : {}), ...(row.updated_at ? { updatedAt: new Date(String(row.updated_at)).toISOString() } : {}), ...(row.thumbnail_key ? { thumbnailKey: String(row.thumbnail_key) } : {}), ...(row.thumbnail_status ? { thumbnailStatus: row.thumbnail_status as LocalMediaAsset['thumbnailStatus'] } : {}), available: row.availability === 'AVAILABLE' }) as LocalMediaAsset);
  }

  async listIndexPage(projectId: string, filters: { query?: string; orientation?: LocalMediaAsset['orientation'] | 'ALL'; category?: string; usage?: 'ALL' | 'UNUSED' | 'RECENT' | 'FREQUENT'; sort?: 'NAME' | 'UPDATED' | 'DURATION' | 'USAGE' | 'RECENT' | 'RECOMMENDED' | 'NEWEST' | 'LEAST_USED' | 'MOST_RECENT'; page?: number; pageSize?: number } = {}): Promise<{ items: LocalMediaAsset[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, filters.page || 1); const pageSize = Math.min(100, Math.max(1, filters.pageSize || 50));
    if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED');
    const params: unknown[] = [projectId]; const clauses = ["s.status = 'SUCCEEDED'", 's.project_id = $1', "i.availability <> 'MISSING'"]; const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
    if (filters.query?.trim()) { const key = add(`%${filters.query.trim()}%`); clauses.push(`(i.file_name ilike ${key} or i.relative_path ilike ${key} or exists (select 1 from jsonb_array_elements_text(i.tags) tag where tag ilike ${key}))`); }
    if (filters.orientation && filters.orientation !== 'ALL') clauses.push(`i.orientation = ${add(filters.orientation)}`);
    if (filters.category) clauses.push(`i.category = ${add(filters.category)}`);
    if (filters.usage === 'UNUSED') clauses.push('i.usage_count = 0');
    if (filters.usage === 'RECENT') clauses.push("i.last_used_at is not null and i.last_used_at > now() - interval '30 days'");
    if (filters.usage === 'FREQUENT') clauses.push('i.usage_count >= 3');
    const order = filters.sort === 'DURATION' ? 'i.duration_ms asc' : filters.sort === 'USAGE' || filters.sort === 'LEAST_USED' ? 'i.usage_count asc, i.last_used_at asc nulls first' : filters.sort === 'RECENT' || filters.sort === 'MOST_RECENT' ? 'i.last_used_at desc nulls last' : filters.sort === 'UPDATED' || filters.sort === 'NEWEST' ? 'i.updated_at desc' : filters.sort === 'RECOMMENDED' ? 'i.usage_count asc, i.last_used_at asc nulls first, i.updated_at desc' : 'i.file_name asc';
    const base = `from local_media_index i join local_media_scan_files f on f.file_id = i.file_id join local_media_scans s on s.id = f.scan_id where ${clauses.join(' and ')}`;
    const countResult = await this.db.query(`select count(distinct i.file_id)::int as total ${base}`, params);
    const dataParams = [...params, pageSize, (page - 1) * pageSize];
    const latestOrder = order.replaceAll('i.', 'latest.');
    const result = await this.db.query(`select * from (select distinct on (i.file_id) i.*, f.source_path, (select count(*) from local_media_usage u where u.media_id = i.file_id and u.render_id in (select recent.render_id from local_media_usage recent group by recent.render_id order by max(recent.used_at) desc limit 10))::int as recent_usage_count ${base} order by i.file_id, s.scanned_at desc nulls last) latest order by ${latestOrder} limit $${dataParams.length - 1} offset $${dataParams.length}`, dataParams);
    const items = result.rows.map((row) => ({ fileName: String(row.file_name), relativePath: String(row.relative_path), sourcePath: String(row.source_path), durationMs: Number(row.duration_ms), width: Number(row.width), height: Number(row.height), orientation: row.orientation as LocalMediaAsset['orientation'], format: String(row.format), ...(row.codec ? { codec: String(row.codec) } : {}), ...(row.file_size != null ? { fileSize: Number(row.file_size) } : {}), ...(row.modified_at ? { modifiedAt: new Date(String(row.modified_at)).toISOString() } : {}), tags: Array.isArray(row.tags) ? row.tags as string[] : [], ...(row.category ? { category: String(row.category) } : {}), usageCount: Number(row.usage_count || 0), recentUsageCount: Number(row.recent_usage_count || 0), ...(row.last_used_at ? { lastUsedAt: new Date(String(row.last_used_at)).toISOString() } : {}), ...(row.created_at ? { createdAt: new Date(String(row.created_at)).toISOString() } : {}), ...(row.updated_at ? { updatedAt: new Date(String(row.updated_at)).toISOString() } : {}), ...(row.thumbnail_key ? { thumbnailKey: String(row.thumbnail_key) } : {}), ...(row.thumbnail_status ? { thumbnailStatus: row.thumbnail_status as LocalMediaAsset['thumbnailStatus'] } : {}), available: row.availability === 'AVAILABLE' }) as LocalMediaAsset);
    return { items, total: Number((countResult.rows[0] as { total?: number } | undefined)?.total || 0), page, pageSize };
  }
  async updateCategory(fileId: string, category: string | null): Promise<void> { if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED'); await this.db.query('update local_media_index set category = $2, updated_at = now() where file_id = $1', [fileId, category?.trim() || null]); }
  async updateTags(fileId: string, tags: string[]): Promise<void> { if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED'); await this.db.query('update local_media_index set tags = $2, updated_at = now() where file_id = $1', [fileId, JSON.stringify([...new Set(tags.map((tag) => tag.trim()).filter(Boolean))])]); }
  async generateThumbnail(fileId: string, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'): Promise<{ key: string; path: string } | null> {
    if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED');
    const row = (await this.db.query<{ source_root_id: string; relative_path: string; source_path: string; duration_ms: number; modified_at: string | null; file_size: number | null }>('select source_root_id, relative_path, source_path, duration_ms, modified_at, file_size from local_media_index where file_id = $1 and availability = \'AVAILABLE\'', [fileId])).rows[0];
    if (!row) return null;
    const key = `${createHash('sha256').update(`${row.source_root_id}:${row.relative_path}:${row.modified_at || ''}:${row.file_size || ''}`).digest('hex')}.jpg`;
    const path = join(this.thumbnailRoot, key);
    try { await accessFile(path); await this.db.query('update local_media_index set thumbnail_key = $2, thumbnail_status = \'READY\', updated_at = now() where file_id = $1', [fileId, key]); return { key, path }; } catch { /* regenerate below */ }
    await this.db.query('update local_media_index set thumbnail_key = $2, thumbnail_status = \'PENDING\', updated_at = now() where file_id = $1', [fileId, key]);
    try { await generateVideoThumbnail(row.source_path, path, ffmpegPath, Number(row.duration_ms)); await this.db.query('update local_media_index set thumbnail_key = $2, thumbnail_status = \'READY\', updated_at = now() where file_id = $1', [fileId, key]); return { key, path }; }
    catch (error) { await this.db.query('update local_media_index set thumbnail_status = \'FAILED\', updated_at = now() where file_id = $1', [fileId]); throw error; }
  }
  async getThumbnail(fileId: string, projectId: string): Promise<{ path: string; key: string } | null> {
    if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED');
    const row = (await this.db.query<{ thumbnail_key: string | null; thumbnail_status: string }>('select i.thumbnail_key, i.thumbnail_status from local_media_index i join local_media_scan_files f on f.file_id = i.file_id join local_media_scans s on s.id = f.scan_id where i.file_id = $1 and s.project_id = $2 and s.status = \'SUCCEEDED\' order by s.scanned_at desc nulls last limit 1', [fileId, projectId])).rows[0];
    if (!row?.thumbnail_key || row.thumbnail_status !== 'READY') return null;
    const path = join(this.thumbnailRoot, row.thumbnail_key); if (!contains(this.thumbnailRoot, resolve(path))) return null;
    try { await accessFile(path); return { path, key: row.thumbnail_key }; } catch { return null; }
  }
  async recordUsage(input: { projectId: string; manifestId: string; renderId: string; mediaIds: string[] }): Promise<void> {
    if (!this.db) throw new Error('LOCAL_MEDIA_DATABASE_REQUIRED');
    const client = await this.db.connect();
    try { await client.query('begin'); for (const mediaId of [...new Set(input.mediaIds)]) { await client.query('insert into local_media_usage (id, media_id, project_id, manifest_id, render_id) values ($1,$2,$3,$4,$5) on conflict (media_id, render_id) do nothing', [`usage-${randomUUID()}`, mediaId, input.projectId, input.manifestId, input.renderId]); await client.query('update local_media_index set usage_count = (select count(*) from local_media_usage where media_id = $1), last_used_at = now(), updated_at = now() where file_id = $1', [mediaId]); } await client.query('commit'); } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  /** Strip the internal path before returning scan data from an HTTP handler. */
  static toPublicFile(file: LocalMediaAsset): Omit<LocalMediaAsset, 'sourcePath'> { const { sourcePath: _sourcePath, ...safe } = file; return safe; }
}
