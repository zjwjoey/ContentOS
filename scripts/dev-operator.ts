import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

function quoteArg(value: string): string { return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value; }
function directInvocation(executable: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: executable, args };
  return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', [quoteArg(executable), ...args.map(quoteArg)].join(' ')] };
}
function launch(executable: string, args: string[], env: NodeJS.ProcessEnv, cwd = root): void {
  const invocation = directInvocation(executable, args);
  const command = invocation.command;
  const commandArgs = invocation.args;
  const child = spawn(command, commandArgs, { cwd, env, stdio: 'inherit', windowsHide: true });
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

const tsx = resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.CMD' : 'tsx');
const next = resolve(root, 'apps', 'web', 'node_modules', '.bin', process.platform === 'win32' ? 'next.CMD' : 'next');
launch(tsx, ['apps/api/src/main.ts'], { ...commonEnv, PORT: process.env.PORT ?? '3000' });
const webMode = process.env.CONTENTOS_WEB_PRODUCTION === '1' ? 'start' : 'dev';
launch(next, [webMode, '-p', process.env.WEB_PORT ?? '3001'], { ...commonEnv, ...(webMode === 'start' ? { NODE_ENV: 'production' } : {}), CONTENTOS_API_URL: process.env.CONTENTOS_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`, PORT: process.env.WEB_PORT ?? '3001' }, resolve(root, 'apps', 'web'));
launch(tsx, ['workers/director-worker/src/dev-main.ts'], { ...commonEnv, PORT: process.env.DIRECTOR_WORKER_PORT ?? '3010' });
launch(tsx, ['workers/asset-worker/src/main.ts'], { ...commonEnv, PORT: process.env.ASSET_WORKER_PORT ?? '3012' });
launch(tsx, ['workers/video-worker/src/main.ts'], { ...commonEnv, PORT: process.env.VIDEO_WORKER_PORT ?? '3015' });
launch(tsx, ['workers/publisher-worker/src/dev-main.ts'], { ...commonEnv, PORT: process.env.PUBLISHER_WORKER_PORT ?? '3020' });
launch(tsx, ['workers/review-worker/src/dev-main.ts'], { ...commonEnv, PORT: process.env.REVIEW_WORKER_PORT ?? '3025' });
launch(tsx, ['workers/benchmark-worker/src/dev-main.ts'], { ...commonEnv, PORT: process.env.BENCHMARK_WORKER_PORT ?? '3026' });
launch(tsx, ['workers/digital-human-worker/src/dev-main.ts'], { ...commonEnv, PORT: process.env.DIGITAL_HUMAN_WORKER_PORT ?? '3027' });
