import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { isPortOpen, isProcessAlive } from '../port.js';
import { assertPostgresResources, resolvePostgresResourcePaths, type PostgresResourcePaths } from './postgres-paths.js';

const execFileAsync = promisify(execFile);

export interface PostgresRuntimeOptions {
  dataRoot: string;
  resourcesRoot: string;
  port: number;
  user: string;
  password: string;
  database: string;
  expectedMajor?: number;
  host?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export interface PostgresRuntimeInfo {
  dataRoot: string;
  resourceRoot: string;
  port: number;
  user: string;
  database: string;
  version: string;
  pid?: number;
}

export interface PostgresHealth {
  state: 'READY' | 'FAILED';
  message: string;
  version?: string;
  pid?: number;
}

function safeIdentifier(value: string, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw Object.assign(new Error(`Invalid PostgreSQL ${name}`), { code: 'POSTGRES_INVALID_CONFIG' });
  return value;
}

function errorCode(error: unknown): string | undefined {
  return typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : undefined;
}

export class PostgresRuntimeManager {
  readonly paths: PostgresResourcePaths;
  private readonly host: string;
  private readonly expectedMajor: number;
  private readonly startupTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private prepared = false;
  private versionValue: string | undefined;

  constructor(private readonly options: PostgresRuntimeOptions) {
    this.paths = resolvePostgresResourcePaths(options.resourcesRoot);
    this.host = options.host || '127.0.0.1';
    this.expectedMajor = options.expectedMajor || 18;
    this.startupTimeoutMs = options.startupTimeoutMs || 60_000;
    this.stopTimeoutMs = options.stopTimeoutMs || 15_000;
    safeIdentifier(options.user, 'user');
    safeIdentifier(options.database, 'database');
    if (this.host !== '127.0.0.1') throw Object.assign(new Error('Bundled PostgreSQL must listen on 127.0.0.1'), { code: 'POSTGRES_INVALID_CONFIG' });
  }

  private async nativePath(file: string): Promise<string> {
    if (process.platform !== 'win32' || !file.includes('\\') || /^[\x00-\x7F]*$/u.test(file)) return file;
    try {
      const command = `for %I in ("${file.replaceAll('"', '""')}") do @echo %~sI`;
      const result = await execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], { timeout: 5_000, windowsHide: true, windowsVerbatimArguments: true, env: process.env });
      const shortPath = String(result.stdout).trim().split(/\r?\n/u).map((value) => value.trim()).find(Boolean);
      return shortPath && !shortPath.includes('\uFFFD') ? shortPath : file;
    } catch { return file; }
  }

  private async run(file: string, args: string[], extraEnv: Record<string, string | undefined> = {}, timeout = this.startupTimeoutMs): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync(await this.nativePath(file), args, { timeout, windowsHide: true, env: { ...process.env, LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'C', LC_MESSAGES: 'C', ...extraEnv } });
    } catch (error) {
      const value = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
      const detail = String(value.stderr || value.stdout || value.message || error).trim().slice(0, 800);
      throw Object.assign(new Error(detail || `PostgreSQL command failed: ${file}`), { code: errorCode(error) || 'POSTGRES_PROCESS_FAILED' });
    }
  }

  private async runDetached(file: string, args: string[], timeout: number): Promise<void> {
    const executable = await this.nativePath(file);
    await new Promise<void>((resolveRun, rejectRun) => {
      const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore', env: { ...process.env, LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'C', LC_MESSAGES: 'C' } });
      let settled = false;
      const timer = setTimeout(() => { if (settled) return; settled = true; child.kill(); rejectRun(Object.assign(new Error(`PostgreSQL command timed out: ${file}`), { code: 'ETIMEDOUT' })); }, timeout);
      child.once('error', (error) => { if (settled) return; settled = true; clearTimeout(timer); rejectRun(Object.assign(new Error(`PostgreSQL command failed: ${error.message}`), { code: errorCode(error) || 'POSTGRES_PROCESS_FAILED' })); });
      child.once('exit', (code, signal) => { if (settled) return; settled = true; clearTimeout(timer); if (code === 0) resolveRun(); else rejectRun(Object.assign(new Error(`PostgreSQL command exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`), { code: 'POSTGRES_PROCESS_FAILED' })); });
    });
  }

  private pidFile(): string { return resolve(this.options.dataRoot, 'postmaster.pid'); }

  private async pid(): Promise<number | undefined> {
    try {
      const firstLine = (await readFile(this.pidFile(), 'utf8')).split(/\r?\n/u)[0]?.trim();
      const value = Number(firstLine);
      return Number.isInteger(value) && value > 0 ? value : undefined;
    } catch { return undefined; }
  }

  private async clearStalePid(): Promise<void> {
    const pid = await this.pid();
    if (pid && isProcessAlive(pid)) throw Object.assign(new Error(`PostgreSQL cluster is already running (pid ${pid})`), { code: 'POSTGRES_ALREADY_RUNNING', pid });
    if (await isPortOpen(this.options.port, this.host)) throw Object.assign(new Error(`PostgreSQL port ${this.options.port} is occupied`), { code: 'POSTGRES_PORT_IN_USE', port: this.options.port });
    await rm(this.pidFile(), { force: true });
  }

  async prepare(): Promise<PostgresRuntimeInfo> {
    if (!this.prepared) {
      await assertPostgresResources(this.paths);
      await mkdir(this.options.dataRoot, { recursive: true });
      this.prepared = true;
    }
    const version = await this.version();
    const pid = await this.pid();
    return { dataRoot: this.options.dataRoot, resourceRoot: this.paths.root, port: this.options.port, user: this.options.user, database: this.options.database, version, ...(pid === undefined ? {} : { pid }) };
  }

  async initialize(): Promise<void> {
    await this.prepare();
    const versionFile = resolve(this.options.dataRoot, 'PG_VERSION');
    try {
      const major = Number.parseInt((await readFile(versionFile, 'utf8')).trim(), 10);
      if (!Number.isInteger(major)) throw new Error('Invalid PG_VERSION');
      if (major !== this.expectedMajor) throw Object.assign(new Error(`PostgreSQL cluster major ${major} is incompatible with bundled major ${this.expectedMajor}`), { code: 'POSTGRES_CLUSTER_INCOMPATIBLE', clusterMajor: major, bundledMajor: this.expectedMajor });
      return;
    } catch (error) {
      if (errorCode(error) === 'POSTGRES_CLUSTER_INCOMPATIBLE') throw error;
      if (errorCode(error) !== 'ENOENT') {
        const entries = await import('node:fs/promises').then((fs) => fs.readdir(this.options.dataRoot));
        if (entries.length > 0) throw Object.assign(new Error('PostgreSQL data directory is not initialized'), { code: 'POSTGRES_DATA_INVALID' });
      }
    }
    const passwordFile = resolve(tmpdir(), `contentos-pg-password-${randomUUID()}`);
    const nativeDataRoot = await this.nativePath(this.options.dataRoot);
    try {
      await writeFile(passwordFile, `${this.options.password}\n`, { encoding: 'utf8', flag: 'wx' });
      await this.run(this.paths.initdb, ['--pgdata', nativeDataRoot, '--username', this.options.user, '--auth', 'scram-sha-256', '--pwfile', passwordFile, '--locale', 'C', '--encoding', 'UTF8']);
      await appendFile(resolve(this.options.dataRoot, 'postgresql.conf'), "\nlisten_addresses = '127.0.0.1'\n", 'utf8');
      await appendFile(resolve(this.options.dataRoot, 'postgresql.conf'), `port = ${this.options.port}\n`, 'utf8');
      await appendFile(resolve(this.options.dataRoot, 'pg_hba.conf'), "\nhost all all 127.0.0.1/32 scram-sha-256\n", 'utf8');
    } catch (error) {
      throw Object.assign(new Error(`PostgreSQL initialization failed: ${error instanceof Error ? error.message : String(error)}`), { code: 'POSTGRES_INIT_FAILED' });
    } finally { await rm(passwordFile, { force: true }); }
  }

  async start(): Promise<PostgresRuntimeInfo> {
    await this.initialize();
    const existingPid = await this.pid();
    if (existingPid && isProcessAlive(existingPid)) {
      if (await isPortOpen(this.options.port, this.host)) return { dataRoot: this.options.dataRoot, resourceRoot: this.paths.root, port: this.options.port, user: this.options.user, database: this.options.database, version: await this.version(), pid: existingPid };
      throw Object.assign(new Error(`PostgreSQL process ${existingPid} is alive but not accepting connections`), { code: 'POSTGRES_START_FAILED', pid: existingPid });
    }
    if (existingPid || await isPortOpen(this.options.port, this.host)) await this.clearStalePid();
    await this.runDetached(this.paths.pgCtl, ['-D', await this.nativePath(this.options.dataRoot), '-o', `-p ${this.options.port} -h ${this.host}`, '-w', 'start'], this.startupTimeoutMs);
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await isPortOpen(this.options.port, this.host)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    if (!(await isPortOpen(this.options.port, this.host))) throw Object.assign(new Error(`PostgreSQL did not open port ${this.options.port}`), { code: 'POSTGRES_START_FAILED', port: this.options.port });
    await this.ensureDatabase();
    const version = await this.version();
    const pid = await this.pid();
    return { dataRoot: this.options.dataRoot, resourceRoot: this.paths.root, port: this.options.port, user: this.options.user, database: this.options.database, version, ...(pid === undefined ? {} : { pid }) };
  }

  private async ensureDatabase(): Promise<void> {
    const escaped = this.options.database.replaceAll("'", "''");
    const client = new pg.Client({ host: this.host, port: this.options.port, user: this.options.user, password: this.options.password, database: 'postgres', connectionTimeoutMillis: 10_000 });
    await client.connect();
    try {
      const result = await client.query<{ exists: number }>('SELECT 1 AS exists FROM pg_database WHERE datname = $1', [this.options.database]);
      if (result.rowCount === 0) await client.query(`CREATE DATABASE "${escaped.replaceAll("'", "''")}"`);
    } finally { await client.end(); }
  }

  async healthCheck(): Promise<PostgresHealth> {
    const pid = await this.pid();
    if (!pid || !isProcessAlive(pid) || !(await isPortOpen(this.options.port, this.host))) return { state: 'FAILED', message: 'Bundled PostgreSQL is not running' };
    return { state: 'READY', message: 'Bundled PostgreSQL reachable', version: await this.version(), pid };
  }

  async stop(): Promise<void> {
    const pid = await this.pid();
    if (!pid && !(await isPortOpen(this.options.port, this.host))) return;
    try {
      await this.runDetached(this.paths.pgCtl, ['-D', await this.nativePath(this.options.dataRoot), '-m', 'fast', '-w', 'stop'], this.stopTimeoutMs);
    } catch (error) {
      if (errorCode(error) !== 'ETIMEDOUT' && errorCode(error) !== 'POSTGRES_PROCESS_FAILED') throw Object.assign(new Error(`PostgreSQL stop failed: ${error instanceof Error ? error.message : String(error)}`), { code: 'POSTGRES_STOP_FAILED' });
      const runningPid = await this.pid();
      if (runningPid && isProcessAlive(runningPid)) {
        if (process.platform === 'win32') await this.run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${runningPid} /T /F`], {}, 10_000).catch(() => undefined);
        else { try { process.kill(runningPid, 'SIGKILL'); } catch { /* already stopped */ } }
      }
    }
  }

  async version(): Promise<string> {
    if (this.versionValue) return this.versionValue;
    const result = await this.run(this.paths.postgres, ['--version'], {}, 10_000);
    const match = `${result.stdout}\n${result.stderr}`.trim().match(/PostgreSQL\)?\s+([0-9]+(?:\.[0-9]+){1,2})/u);
    if (!match?.[1]) throw Object.assign(new Error('Unable to determine bundled PostgreSQL version'), { code: 'POSTGRES_VERSION_UNKNOWN' });
    this.versionValue = match[1];
    return this.versionValue;
  }

  connectionUrl(): string {
    return `postgresql://${encodeURIComponent(this.options.user)}:${encodeURIComponent(this.options.password)}@${this.host}:${this.options.port}/${encodeURIComponent(this.options.database)}`;
  }
}
