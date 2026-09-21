import { execFile as execFileCallback } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MAX_HELPER_OUTPUT_BYTES = 10 * 1024 * 1024;
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);

export interface ReadableDraftAdapter {
  readonly id: string;
  read(path: string): Promise<{ rootPath: string; payloads: Record<string, unknown>[] }>;
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isEncryptedFallbackCandidate(error: unknown): boolean {
  return ['JIANYING_DRAFT_INVALID_JSON', 'JIANYING_DRAFT_ENCRYPTED', 'JIANYING_DRAFT_NOT_READABLE_AS_JSON'].includes(errorCode(error));
}

export class PlainJsonDraftAdapter implements ReadableDraftAdapter {
  readonly id = 'PLAIN_JSON';

  async read(path: string): Promise<{ rootPath: string; payloads: Record<string, unknown>[] }> {
    const absolutePath = resolve(path);
    let pathStat;
    try { pathStat = await stat(absolutePath); } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') throw new Error('JIANYING_DRAFT_NOT_FOUND');
      throw new Error('JIANYING_DRAFT_NOT_READABLE');
    }
    const rootPath = pathStat.isDirectory() ? absolutePath : dirname(absolutePath);
    const payloads: Record<string, unknown>[] = [];
    const parse = (content: string): void => {
      try {
        const payload = JSON.parse(content) as unknown;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('not-an-object');
        payloads.push(payload as Record<string, unknown>);
      } catch {
        throw new Error('JIANYING_DRAFT_INVALID_JSON');
      }
    };
    if (pathStat.isDirectory()) {
      for (const fileName of ['draft_content.json', 'draft_info.json']) {
        const content = await readFile(join(absolutePath, fileName), 'utf8').catch((error: unknown) => {
          if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') return null;
          throw new Error('JIANYING_DRAFT_NOT_READABLE');
        });
        if (content !== null) parse(content);
      }
      if (!payloads.length) throw new Error('JIANYING_DRAFT_NOT_READABLE');
    } else {
      let content: string;
      try { content = await readFile(absolutePath, 'utf8'); } catch { throw new Error('JIANYING_DRAFT_NOT_READABLE'); }
      parse(content);
    }
    return { rootPath, payloads };
  }
}

export interface JianyingRuntimeLocatorOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

async function existingFile(candidate: string | undefined): Promise<string | undefined> {
  if (!candidate) return undefined;
  const details = await stat(candidate).catch(() => null);
  if (!details?.isFile()) return undefined;
  return realpath(candidate).catch(() => resolve(candidate));
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)).map((value) => resolve(value)))];
}

export class JianyingRuntimeLocator {
  readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: JianyingRuntimeLocatorOptions = {}) {
    this.platform = options.platform || process.platform;
    this.env = options.env || process.env;
  }

  async findVideoEditorDll(): Promise<string | undefined> {
    const explicit = await existingFile(this.env.JIANYING_VIDEOEDITOR_DLL);
    if (explicit) return explicit;
    if (this.platform !== 'win32') return undefined;
    const roots = [this.env.ProgramFiles, this.env['ProgramFiles(x86)'], this.env.LOCALAPPDATA, this.env.APPDATA];
    const relativePaths = [
      'JianyingPro\\resources\\videoeditor.dll',
      'JianyingPro\\videoeditor.dll',
      'ByteDance\\JianyingPro\\resources\\videoeditor.dll',
      'CapCut\\resources\\videoeditor.dll',
    ];
    for (const candidate of unique(roots.flatMap((root) => relativePaths.map((relativePath) => root ? join(root, relativePath) : undefined)))) {
      const found = await existingFile(candidate);
      if (found) return found;
    }
    return undefined;
  }

  async findDraftHelper(): Promise<string | undefined> {
    const explicit = await existingFile(this.env.JIANYING_DRAFT_HELPER);
    if (explicit) return explicit;
    if (this.platform !== 'win32') return undefined;
    const roots = [this.env.ProgramFiles, this.env['ProgramFiles(x86)'], this.env.LOCALAPPDATA, this.env.APPDATA];
    const relativePaths = [
      'JianyingPro\\tools\\jianying-draft-helper.exe',
      'JianyingPro\\jianying-draft-helper.exe',
      'ContentOS\\helpers\\jianying-draft-helper.exe',
    ];
    for (const candidate of unique(roots.flatMap((root) => relativePaths.map((relativePath) => root ? join(root, relativePath) : undefined)))) {
      const found = await existingFile(candidate);
      if (found) return found;
    }
    return undefined;
  }
}

export interface JianyingHelperResult {
  stdout: string;
  stderr: string;
}

export type JianyingHelperExecutor = (helperPath: string, args: string[]) => Promise<JianyingHelperResult>;

async function executeHelper(helperPath: string, args: string[]): Promise<JianyingHelperResult> {
  try {
    const result = await execFile(helperPath, args, { windowsHide: true, maxBuffer: MAX_HELPER_OUTPUT_BYTES });
    return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  } catch (error) {
    const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer; code?: string | number };
    const wrapped = new Error(`JIANYING_HELPER_FAILED:${String(failure.code || '')}`);
    Object.assign(wrapped, { stdout: String(failure.stdout || ''), stderr: String(failure.stderr || '') });
    throw wrapped;
  }
}

export interface JianyingEncryptedDraftAdapterOptions {
  locator?: JianyingRuntimeLocator;
  executor?: JianyingHelperExecutor;
  platform?: NodeJS.Platform;
  temporaryRoot?: string;
}

function helperFailureCode(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return parsed.status === 'error' && typeof parsed.code === 'string' ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

function mapHelperFailure(stdout: string): Error {
  const code = helperFailureCode(stdout);
  if (code === 'UNSUPPORTED_DRAFT_VERSION') return new Error('JIANYING_UNSUPPORTED_DRAFT_VERSION');
  return new Error('JIANYING_HELPER_FAILED');
}

function parseHelperSuccess(stdout: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('JIANYING_DECRYPT_OUTPUT_INVALID'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('JIANYING_DECRYPT_OUTPUT_INVALID');
  const result = parsed as Record<string, unknown>;
  if (result.status === 'error') throw mapHelperFailure(stdout);
  if (result.status !== 'ok' || !Array.isArray(result.files) || !result.files.length || result.files.some((file) => typeof file !== 'string' || !file.trim())) throw new Error('JIANYING_DECRYPT_OUTPUT_INVALID');
  return result.files as string[];
}

function safeOutputFile(outputDirectory: string, fileName: string): string {
  const candidate = resolve(outputDirectory, fileName);
  const relativePath = relative(outputDirectory, candidate);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error('JIANYING_DECRYPT_OUTPUT_INVALID');
  return candidate;
}

function isMetadataFile(fileName: string): boolean {
  const extension = extname(fileName).toLocaleLowerCase();
  return extension === '.json' || extension === '.draft' || extension === '.dat' || (/draft|content|timeline|project|info/i.test(fileName) && !MEDIA_EXTENSIONS.has(extension));
}

async function copyDraftInput(sourcePath: string, inputDirectory: string): Promise<{ inputPath: string; rootPath: string }> {
  const sourceStat = await stat(sourcePath).catch(() => null);
  if (!sourceStat) throw new Error('JIANYING_DRAFT_NOT_FOUND');
  if (sourceStat.isFile()) {
    const inputPath = join(inputDirectory, basename(sourcePath));
    await copyFile(sourcePath, inputPath);
    return { inputPath, rootPath: dirname(sourcePath) };
  }
  if (!sourceStat.isDirectory()) throw new Error('JIANYING_DRAFT_NOT_READABLE');
  const entries = await readdir(sourcePath, { withFileTypes: true });
  const metadata = entries.filter((entry) => entry.isFile() && isMetadataFile(entry.name));
  if (!metadata.length) throw new Error('JIANYING_DRAFT_NOT_READABLE');
  for (const entry of metadata) await copyFile(join(sourcePath, entry.name), join(inputDirectory, entry.name));
  return { inputPath: inputDirectory, rootPath: sourcePath };
}

export class JianyingEncryptedDraftAdapter implements ReadableDraftAdapter {
  readonly id: string = 'JIANYING_ENCRYPTED';
  private readonly locator: JianyingRuntimeLocator;
  private readonly executor: JianyingHelperExecutor;
  private readonly platform: NodeJS.Platform;
  private readonly temporaryRoot: string;

  constructor(options: JianyingEncryptedDraftAdapterOptions = {}) {
    this.locator = options.locator || new JianyingRuntimeLocator(options.platform ? { platform: options.platform } : {});
    this.executor = options.executor || executeHelper;
    this.platform = options.platform || this.locator.platform;
    this.temporaryRoot = options.temporaryRoot || tmpdir();
  }

  async read(path: string): Promise<{ rootPath: string; payloads: Record<string, unknown>[] }> {
    if (this.platform !== 'win32') throw new Error('JIANYING_ENCRYPTED_DRAFT_REQUIRES_WINDOWS_RUNTIME');
    const sourcePath = resolve(path);
    const dllPath = await this.locator.findVideoEditorDll();
    if (!dllPath) throw new Error('JIANYING_VIDEOEDITOR_DLL_UNAVAILABLE');
    const helperPath = await this.locator.findDraftHelper();
    if (!helperPath) throw new Error('JIANYING_HELPER_UNAVAILABLE');
    const temporaryDirectory = await mkdtemp(join(this.temporaryRoot, 'contentos-jianying-draft-'));
    try {
      const inputDirectory = join(temporaryDirectory, 'input');
      const outputDirectory = join(temporaryDirectory, 'output');
      await mkdir(inputDirectory, { recursive: true });
      await mkdir(outputDirectory, { recursive: true });
      const input = await copyDraftInput(sourcePath, inputDirectory);
      let result: JianyingHelperResult;
      try {
        result = await this.executor(helperPath, ['--input', input.inputPath, '--output', outputDirectory, '--dll', dllPath]);
      } catch (error) {
        const stdout = error && typeof error === 'object' && 'stdout' in error ? String((error as { stdout?: unknown }).stdout || '') : '';
        throw mapHelperFailure(stdout);
      }
      const files = parseHelperSuccess(result.stdout);
      const payloads: Record<string, unknown>[] = [];
      for (const file of files) {
        const outputPath = safeOutputFile(outputDirectory, file);
        let content: string;
        try { content = await readFile(outputPath, 'utf8'); } catch { throw new Error('JIANYING_DECRYPT_OUTPUT_INVALID'); }
        try {
          const payload = JSON.parse(content) as unknown;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid-payload');
          payloads.push(payload as Record<string, unknown>);
        } catch { throw new Error('JIANYING_DECRYPT_OUTPUT_INVALID'); }
      }
      return { rootPath: input.rootPath, payloads };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export class CompositeReadableDraftAdapter implements ReadableDraftAdapter {
  readonly id = 'COMPOSITE';

  constructor(private readonly plain: ReadableDraftAdapter = new PlainJsonDraftAdapter(), private readonly encrypted: ReadableDraftAdapter = new JianyingEncryptedDraftAdapter()) {}

  async read(path: string): Promise<{ rootPath: string; payloads: Record<string, unknown>[] }> {
    try { return await this.plain.read(path); } catch (error) {
      if (!isEncryptedFallbackCandidate(error)) throw error;
      return this.encrypted.read(path);
    }
  }
}

export class JianyingVideoEditorDllAdapter extends JianyingEncryptedDraftAdapter {
  readonly id = 'JIANYING_VIDEOEDITOR_DLL';
  readonly status: 'AVAILABLE' | 'UNAVAILABLE';

  constructor(dllPath = process.env.JIANYING_VIDEOEDITOR_DLL, options: Omit<JianyingEncryptedDraftAdapterOptions, 'locator'> & { locator?: JianyingRuntimeLocator } = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(dllPath ? { JIANYING_VIDEOEDITOR_DLL: dllPath } : {}) };
    const locator = options.locator || new JianyingRuntimeLocator({ ...(options.platform ? { platform: options.platform } : {}), env });
    super({ ...options, locator });
    this.status = dllPath ? 'AVAILABLE' : 'UNAVAILABLE';
  }
}
