import { access, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { isPortOpen } from './port.js';
import type { DoctorCheck, DoctorReport } from './types.js';
import type { RuntimePaths } from './paths.js';
import pg from 'pg';
const run = promisify(execFile);

export async function runDoctor(paths: RuntimePaths, env: Record<string, string | undefined> = process.env): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []; const check = async (id: string, scope: 'CORE' | 'OPTIONAL', action: () => Promise<string>) => { try { checks.push({ id, scope, status: 'PASS', message: await action() }); } catch (error) { checks.push({ id, scope, status: scope === 'CORE' ? 'FAIL' : 'WARN', message: error instanceof Error ? error.message : String(error) }); } };
  await check('node', 'CORE', async () => { const major = Number(process.versions.node.split('.')[0]); if (major < 22) throw new Error(`Node ${process.version}，需要 >=22`); return process.version; });
  await check('pnpm', 'CORE', async () => { if (env.CONTENTOS_RUNTIME_MODE === 'PACKAGED') return 'PACKAGED 模式不要求 pnpm'; const result = process.platform === 'win32' ? await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm --version'], { timeout: 5000 }) : await run('pnpm', ['--version'], { timeout: 5000 }); return `pnpm ${String(result.stdout).trim()}`; });
  await check('database-config', 'CORE', async () => { if (!env.DATABASE_URL) throw new Error('DATABASE_URL 未配置'); return 'DATABASE_URL 已配置'; });
  await check('database', 'CORE', async () => { if (!env.DATABASE_URL) throw new Error('DATABASE_URL 未配置'); const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 3000 }); try { await pool.query('select 1'); return 'PostgreSQL 可连接'; } finally { await pool.end(); } });
  await check('storage', 'CORE', async () => { await mkdir(paths.storageRoot, { recursive: true }); await access(paths.storageRoot); return paths.storageRoot; });
  await check('runtime-root', 'CORE', async () => { await mkdir(paths.runtimeRoot, { recursive: true }); await access(paths.runtimeRoot); return paths.runtimeRoot; });
  await check('temp', 'CORE', async () => { const file = `${tmpdir()}/contentos-doctor-${process.pid}-${Date.now()}.tmp`; await writeFile(file, 'ok', 'utf8'); await rm(file, { force: true }); return tmpdir(); });
  await check('ffmpeg', 'CORE', async () => { await run(env.FFMPEG_PATH || 'ffmpeg', ['-version'], { timeout: 5000 }); return 'ffmpeg 可用'; });
  await check('ffprobe', 'CORE', async () => { await run(env.FFPROBE_PATH || 'ffprobe', ['-version'], { timeout: 5000 }); return 'ffprobe 可用'; });
  await check('api-port', 'CORE', async () => { const port = Number(env.PORT || 3000); if (await isPortOpen(port)) { if (env.CONTENTOS_RUNTIME_OWNS_PORTS === '1') return `端口 ${port} 由当前 Runtime 占用`; throw new Error(`PORT_IN_USE:api:${port}`); } return '端口可用'; });
  await check('web-port', 'CORE', async () => { const port = Number(env.WEB_PORT || 3001); if (await isPortOpen(port)) { if (env.CONTENTOS_RUNTIME_OWNS_PORTS === '1') return `端口 ${port} 由当前 Runtime 占用`; throw new Error(`PORT_IN_USE:web:${port}`); } return '端口可用'; });
  await check('playwright', 'OPTIONAL', async () => { await import('playwright'); return 'Playwright 可用'; });
  await check('digital-human', 'OPTIONAL', async () => { if (!env.CONTENTOS_HZAGENT_API_KEY) throw new Error('NOT_CONFIGURED'); return 'HZAgent 已配置'; });
  await check('publisher', 'OPTIONAL', async () => { if (env.PUBLISHER_REAL_ADAPTERS_ENABLED !== '1' && env.PUBLISHER_REAL_ADAPTERS_ENABLED !== 'true') throw new Error('NOT_CONFIGURED'); return 'Publisher 适配器已启用'; });
  await check('qwen', 'OPTIONAL', async () => { if (!env.QWEN_API_KEY || !(env.QWEN_BASE_URL || env.QWEN_API_URL)) throw new Error('NOT_CONFIGURED'); return 'Qwen 已配置'; });
  await check('pexels', 'OPTIONAL', async () => { if (!env.PEXELS_API_KEY) throw new Error('NOT_CONFIGURED'); return 'Pexels 已配置'; });
  await check('jianying', 'OPTIONAL', async () => { if (!env.JIANYING_DRAFT_HELPER && !env.JIANYING_VIDEOEDITOR_DLL) throw new Error('NOT_CONFIGURED'); await access(env.JIANYING_DRAFT_HELPER || env.JIANYING_VIDEOEDITOR_DLL || ''); return '剪映运行时已配置'; });
  return { generatedAt: new Date().toISOString(), checks, coreStartup: checks.some((item) => item.scope === 'CORE' && item.status === 'FAIL') ? 'NOT_READY' : 'READY' };
}
