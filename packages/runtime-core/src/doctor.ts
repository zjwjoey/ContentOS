import { access, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isPortOpen } from './port.js';
import type { DoctorCheck, DoctorReport } from './types.js';
import type { RuntimePaths } from './paths.js';
const run = promisify(execFile);

export async function runDoctor(paths: RuntimePaths, env: Record<string, string | undefined> = process.env): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []; const check = async (id: string, scope: 'CORE' | 'OPTIONAL', action: () => Promise<string>) => { try { checks.push({ id, scope, status: 'PASS', message: await action() }); } catch (error) { checks.push({ id, scope, status: scope === 'CORE' ? 'FAIL' : 'WARN', message: error instanceof Error ? error.message : String(error) }); } };
  await check('node', 'CORE', async () => { const major = Number(process.versions.node.split('.')[0]); if (major < 22) throw new Error(`Node ${process.version}，需要 >=22`); return process.version; });
  await check('pnpm', 'CORE', async () => { const result = process.platform === 'win32' ? await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm --version'], { timeout: 5000 }) : await run('pnpm', ['--version'], { timeout: 5000 }); return `pnpm ${String(result.stdout).trim()}`; });
  await check('database-config', 'CORE', async () => { if (!env.DATABASE_URL) throw new Error('DATABASE_URL 未配置'); return 'DATABASE_URL 已配置'; });
  await check('storage', 'CORE', async () => { await mkdir(paths.storageRoot, { recursive: true }); await access(paths.storageRoot); return paths.storageRoot; });
  await check('runtime-root', 'CORE', async () => { await mkdir(paths.runtimeRoot, { recursive: true }); await access(paths.runtimeRoot); return paths.runtimeRoot; });
  await check('ffmpeg', 'CORE', async () => { await run(env.FFMPEG_PATH || 'ffmpeg', ['-version'], { timeout: 5000 }); return 'ffmpeg 可用'; });
  await check('ffprobe', 'CORE', async () => { await run(env.FFPROBE_PATH || 'ffprobe', ['-version'], { timeout: 5000 }); return 'ffprobe 可用'; });
  await check('api-port', 'CORE', async () => { if (await isPortOpen(Number(env.PORT || 3000))) return '端口已被服务占用（可能已有实例）'; return '端口可用'; });
  await check('web-port', 'CORE', async () => { if (await isPortOpen(Number(env.WEB_PORT || 3001))) return '端口已被服务占用（可能已有实例）'; return '端口可用'; });
  await check('playwright', 'OPTIONAL', async () => { await import('playwright'); return 'Playwright 可用'; });
  await check('digital-human', 'OPTIONAL', async () => { if (!env.CONTENTOS_HZAGENT_API_KEY) throw new Error('NOT_CONFIGURED'); return 'HZAgent 已配置'; });
  await check('publisher', 'OPTIONAL', async () => { if (env.PUBLISHER_REAL_ADAPTERS_ENABLED !== '1' && env.PUBLISHER_REAL_ADAPTERS_ENABLED !== 'true') throw new Error('NOT_CONFIGURED'); return 'Publisher 适配器已启用'; });
  return { generatedAt: new Date().toISOString(), checks, coreStartup: checks.some((item) => item.scope === 'CORE' && item.status === 'FAIL') ? 'NOT_READY' : 'READY' };
}
