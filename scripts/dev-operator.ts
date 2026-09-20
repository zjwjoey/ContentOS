import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmCommand = 'pnpm';
const databaseUrl = process.env.CONTENTOS_OPERATOR_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://contentos_dev@127.0.0.1:55433/contentos_operator_dev';
const commonEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development' as const,
  DATABASE_URL: databaseUrl,
  STORAGE_ROOT: process.env.STORAGE_ROOT ?? resolve(root, 'storage/local'),
  FFMPEG_PATH: process.env.FFMPEG_PATH ?? 'ffmpeg',
  FFPROBE_PATH: process.env.FFPROBE_PATH ?? 'ffprobe',
  FFMPEG_FONT_FILE: process.env.FFMPEG_FONT_FILE ?? 'C:\\Windows\\Fonts\\msyh.ttc',
};

// Windows FFmpeg builds may depend on sibling DLLs. Ensure every composed
// worker can resolve those DLLs when an absolute executable path is configured.
if (process.platform === 'win32') {
  const executableDirs = [commonEnv.FFMPEG_PATH, commonEnv.FFPROBE_PATH]
    .filter((value): value is string => Boolean(value) && value !== 'ffmpeg' && value !== 'ffprobe')
    .map((value) => dirname(resolve(value)));
  commonEnv.PATH = [...new Set([...executableDirs, process.env.PATH ?? ''])].join(';');
}

const children: ChildProcess[] = [];
let stopping = false;

function launch(args: string[], env: NodeJS.ProcessEnv): void {
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : pnpmCommand;
  const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', [pnpmCommand, ...args].join(' ')] : args;
  const child = spawn(command, commandArgs, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.once('exit', (code) => {
    if (!stopping && code !== 0) {
      console.error(`ContentOS operator child exited with code ${code ?? 'unknown'}`);
      process.exitCode = code ?? 1;
      stopChildren();
    }
  });
}

function launchDirect(packageName: string, entry: string, env: NodeJS.ProcessEnv, cwd = root, args: string[] = []): void {
  const node = process.execPath;
  const runner = packageName === '@contentos/web'
    ? resolve(root, 'apps/web/node_modules/next/dist/bin/next')
    : resolve(root, 'node_modules/tsx/dist/cli.mjs');
  const child = spawn(node, [runner, ...(packageName === '@contentos/web' ? args : [entry, ...args])], { cwd, env, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.once('exit', (code) => {
    if (!stopping && code !== 0) {
      console.error(`ContentOS operator child exited with code ${code ?? 'unknown'}`);
      process.exitCode = code ?? 1;
      stopChildren();
    }
  });
}

function stopChildren(): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGINT');
  setTimeout(() => { for (const child of children) if (!child.killed) child.kill(); }, 3_000).unref();
}

process.once('SIGINT', stopChildren);
process.once('SIGTERM', stopChildren);

const direct = process.env.CONTENTOS_OPERATOR_DIRECT === '1';
if (direct) {
  launchDirect('@contentos/api', 'apps/api/src/main.ts', { ...commonEnv, PORT: process.env.PORT ?? '3000' });
} else launch(['--filter', '@contentos/api', 'dev'], { ...commonEnv, PORT: process.env.PORT ?? '3000' });
const webMode: 'start' | 'dev' = process.env.CONTENTOS_WEB_PRODUCTION === '1' ? 'start' : 'dev';
const webNodeEnv: NodeJS.ProcessEnv = webMode === 'start' ? { NODE_ENV: 'production' } : { NODE_ENV: 'development' };
const webEnv: NodeJS.ProcessEnv = { ...commonEnv, ...webNodeEnv, CONTENTOS_API_URL: process.env.CONTENTOS_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`, PORT: process.env.WEB_PORT ?? '3001' };
if (direct) {
  launchDirect('@contentos/web', '', webEnv, resolve(root, 'apps/web'), [webMode, '-p', process.env.WEB_PORT ?? '3001']);
  launchDirect('@contentos/director-worker', 'workers/director-worker/src/dev-main.ts', { ...commonEnv, PORT: process.env.DIRECTOR_WORKER_PORT ?? '3010' });
  launchDirect('@contentos/asset-worker', 'workers/asset-worker/src/main.ts', { ...commonEnv, PORT: process.env.ASSET_WORKER_PORT ?? '3012' });
  launchDirect('@contentos/worker-video', 'workers/video-worker/src/main.ts', { ...commonEnv, PORT: process.env.VIDEO_WORKER_PORT ?? '3015' });
  launchDirect('@contentos/worker-publisher', 'workers/publisher-worker/src/dev-main.ts', { ...commonEnv, PORT: process.env.PUBLISHER_WORKER_PORT ?? '3020' });
  launchDirect('@contentos/review-worker', 'workers/review-worker/src/dev-main.ts', { ...commonEnv, PORT: process.env.REVIEW_WORKER_PORT ?? '3025' });
  launchDirect('@contentos/benchmark-worker', 'workers/benchmark-worker/src/dev-main.ts', { ...commonEnv, PORT: process.env.BENCHMARK_WORKER_PORT ?? '3026' });
} else {
  launch(['--filter', '@contentos/web', 'exec', 'next', webMode, '-p', process.env.WEB_PORT ?? '3001'], webEnv);
  launch(['--filter', '@contentos/director-worker', 'dev'], { ...commonEnv, PORT: process.env.DIRECTOR_WORKER_PORT ?? '3010' });
  launch(['--filter', '@contentos/asset-worker', 'dev'], { ...commonEnv, PORT: process.env.ASSET_WORKER_PORT ?? '3012' });
  launch(['--filter', '@contentos/worker-video', 'dev'], { ...commonEnv, PORT: process.env.VIDEO_WORKER_PORT ?? '3015' });
  launch(['--filter', '@contentos/worker-publisher', 'dev'], { ...commonEnv, PORT: process.env.PUBLISHER_WORKER_PORT ?? '3020' });
  launch(['--filter', '@contentos/review-worker', 'dev'], { ...commonEnv, PORT: process.env.REVIEW_WORKER_PORT ?? '3025' });
  launch(['--filter', '@contentos/benchmark-worker', 'dev'], { ...commonEnv, PORT: process.env.BENCHMARK_WORKER_PORT ?? '3026' });
}
