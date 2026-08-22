import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmCommand = 'pnpm';
const databaseUrl = process.env.CONTENTOS_OPERATOR_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://contentos_dev@127.0.0.1:55433/contentos_operator_dev';
const commonEnv = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: databaseUrl,
  STORAGE_ROOT: process.env.STORAGE_ROOT ?? resolve(root, 'storage/local'),
  FFMPEG_PATH: process.env.FFMPEG_PATH ?? 'ffmpeg',
  FFPROBE_PATH: process.env.FFPROBE_PATH ?? 'ffprobe',
  FFMPEG_FONT_FILE: process.env.FFMPEG_FONT_FILE ?? 'C:\\Windows\\Fonts\\msyh.ttc',
};

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

function stopChildren(): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGINT');
  setTimeout(() => { for (const child of children) if (!child.killed) child.kill(); }, 3_000).unref();
}

process.once('SIGINT', stopChildren);
process.once('SIGTERM', stopChildren);

launch(['--filter', '@contentos/api', 'dev'], { ...commonEnv, PORT: process.env.PORT ?? '3000' });
launch(['--filter', '@contentos/web', 'dev'], { ...commonEnv, CONTENTOS_API_URL: process.env.CONTENTOS_API_URL ?? 'http://127.0.0.1:3000', PORT: '3001' });
launch(['--filter', '@contentos/director-worker', 'dev'], { ...commonEnv, PORT: process.env.DIRECTOR_WORKER_PORT ?? '3010' });
