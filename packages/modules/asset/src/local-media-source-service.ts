import { readdir, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { probeMedia, type ProbeResult } from '../../../infrastructure/ffmpeg/src/index.js';

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

  constructor(options: LocalMediaSourceOptions = {}) {
    this.roots = normalizedRoots(options.allowedRoots ?? (process.env.CONTENTOS_LOCAL_MEDIA_ROOTS || '').split(';').filter(Boolean));
    this.ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
    this.probe = options.probe || ((path) => probeMedia(path, this.ffprobePath));
  }

  authorizeRoot(input: string): { root: string; sourceRootId: string } {
    if (!input || input.includes('\0')) throw new Error('LOCAL_MEDIA_ROOT_INVALID');
    const root = resolve(input);
    const authorized = this.roots.find((candidate) => contains(candidate, root));
    if (!authorized) throw new Error('LOCAL_MEDIA_ROOT_UNAUTHORIZED');
    return { root, sourceRootId: publicRootId(root) };
  }

  async scan(input: { sourceRoot: string; recursive?: boolean }): Promise<LocalMediaScanResult> {
    const { root, sourceRootId } = this.authorizeRoot(input.sourceRoot);
    const rootStat = await stat(root).catch(() => null);
    if (!rootStat?.isDirectory()) throw new Error('LOCAL_MEDIA_ROOT_NOT_FOUND');
    const files: LocalMediaAsset[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const fullPath = resolve(directory, entry.name);
        if (entry.isDirectory()) { if (input.recursive !== false) await visit(fullPath); continue; }
        if (!entry.isFile() || !LOCAL_VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
        const relativePath = relative(root, fullPath).split(/[\\/]+/gu).join('/');
        try {
          const metadata = await this.probe(fullPath);
          const available = metadata.width > 0 && metadata.durationMs > 0;
          files.push({ fileName: basename(fullPath), relativePath, durationMs: metadata.durationMs, width: metadata.width, height: metadata.height, format: metadata.format, ...(metadata.videoCodec ? { codec: metadata.videoCodec } : {}), available, ...(available ? {} : { errorMessage: '无法读取视频元数据' }), sourcePath: fullPath });
        } catch (error) {
          files.push({ fileName: basename(fullPath), relativePath, durationMs: 0, width: 0, height: 0, format: extname(entry.name).slice(1), available: false, errorMessage: error instanceof Error ? error.message.slice(0, 200) : '无法读取视频', sourcePath: fullPath });
        }
      }
    };
    await visit(root);
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { sourceRootId, files, totalCount: files.length, availableCount: files.filter((file) => file.available).length, unavailableCount: files.filter((file) => !file.available).length };
  }

  /** Strip the internal path before returning scan data from an HTTP handler. */
  static toPublicFile(file: LocalMediaAsset): Omit<LocalMediaAsset, 'sourcePath'> { const { sourcePath: _sourcePath, ...safe } = file; return safe; }
}
