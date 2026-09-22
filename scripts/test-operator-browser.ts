import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDatabase, migrateUp } from '../packages/database/src/index.js';
import { generateFixtureAudio, generateFixtureVideo } from '../packages/infrastructure/ffmpeg/src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adminUrl = process.env.CONTENTOS_TEST_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://contentos_dev:change-me@127.0.0.1:5432/contentos_test';
const directOperator = process.env.CONTENTOS_OPERATOR_DIRECT !== '0';

function pnpmInvocation(args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: 'pnpm', args };
  const commandLine = ['pnpm.cmd', ...args].join(' ');
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', commandLine] };
}

function tsxInvocation(args: string[]): { command: string; args: string[] } {
  const executable = resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.CMD' : 'tsx');
  if (process.platform !== 'win32') return { command: executable, args };
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', [executable, ...args].join(' ')] };
}

function scopedDatabaseUrl(schema: string): string {
  const url = new URL(adminUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePort());
  });
  const address = server.address();
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  if (!address || typeof address === 'string') throw new Error('Unable to allocate loopback port');
  return address.port;
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'operator did not respond';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : 'health request failed'; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Timed out waiting for isolated operator: ${lastError}`);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal ?? 'unknown'}`)));
  });
}

function spawnPnpm(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const invocation = pnpmInvocation(args);
  return spawn(invocation.command, invocation.args, {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
}

function spawnTsx(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const invocation = tsxInvocation(args);
  return spawn(invocation.command, invocation.args, { cwd: root, env, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
}

async function stopOwnedTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolveStop) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => resolveStop());
      killer.once('exit', () => resolveStop());
    });
    return;
  }
  const processGroupId = -child.pid;
  await new Promise<void>((resolveStop) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      resolveStop();
    };
    const forceKillTimer = setTimeout(() => {
      try {
        process.kill(processGroupId, 'SIGKILL');
      } catch {
        // The process group may already have exited.
      }
      finish();
    }, 3_000);
    child.once('exit', finish);
    try {
      process.kill(processGroupId, 'SIGTERM');
    } catch {
      finish();
    }
  });
}

async function main(): Promise<void> {
  const schema = `contentos_browser_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: adminUrl });
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'contentos-browser-acceptance-'));
  const fakeAvatarRoot = await mkdtemp(join(tmpdir(), 'contentos-fake-avatar-'));
  const storageRoot = join(temporaryRoot, 'storage');
  const fixtureVideos = ['source.mp4', 'source-2.mp4', 'source-3.mp4', 'source-4.mp4', 'source-5.mp4'].map((name) => join(temporaryRoot, name));
  const fakeAvatarOutput = join(fakeAvatarRoot, 'avatar-output.mp4');
  const fixtureAudio = join(temporaryRoot, 'voice.wav');
  const apiPort = await freePort();
  const webPort = await freePort();
  const databaseUrl = scopedDatabaseUrl(schema);
  let operator: ChildProcess | undefined;
  let fakeAvatarServer: HttpServer | undefined;
  try {
    await admin.query(`create schema "${schema}"`);
    const database = await createDatabase(databaseUrl);
    try { await migrateUp(database); } finally { await database.end(); }
    await mkdir(storageRoot, { recursive: true });
    for (const [index, path] of fixtureVideos.entries()) await generateFixtureVideo(path, process.env.FFMPEG_PATH ?? 'ffmpeg', ['0x2057d4', '0x3b82f6', '0x16a34a', '0xea580c'][index]!, 6);
    await generateFixtureAudio(fixtureAudio, process.env.FFMPEG_PATH ?? 'ffmpeg');
    // The fake provider output must obey the same duration contract as a real
    // provider: its video duration must match the generated speech fixture.
    await generateFixtureVideo(fakeAvatarOutput, process.env.FFMPEG_PATH ?? 'ffmpeg', '0x2057d4', 5);
    const fakeAvatarPort = await freePort();
    fakeAvatarServer = createHttpServer((request, response) => { if (request.url === '/avatar.mp4') { response.writeHead(200, { 'content-type': 'video/mp4' }); createReadStream(fakeAvatarOutput).pipe(response); return; } response.writeHead(404).end(); });
    await new Promise<void>((resolveListen, rejectListen) => { fakeAvatarServer!.once('error', rejectListen); fakeAvatarServer!.listen(fakeAvatarPort, '127.0.0.1', () => resolveListen()); });

    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const webUrl = `http://127.0.0.1:${webPort}`;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'development',
      DATABASE_URL: databaseUrl,
      CONTENTOS_OPERATOR_DATABASE_URL: databaseUrl,
      STORAGE_ROOT: storageRoot,
      PORT: String(apiPort),
      WEB_PORT: String(webPort),
      CONTENTOS_API_URL: apiUrl,
      CONTENTOS_FAKE_PUBLISHER_CONTROLS: '1',
      CONTENTOS_FAKE_PEXELS: '1',
      CONTENTOS_FAKE_PEXELS_FIXTURE: fixtureVideos[1]!,
      CONTENTOS_LOCAL_MEDIA_ROOTS: temporaryRoot,
      CONTENTOS_MUSIC_ROOTS: temporaryRoot,
      CONTENTOS_OUTPUT_ROOTS: temporaryRoot,
      CONTENTOS_SPEECH_PROVIDER: 'fake-speech',
      CONTENTOS_AVATAR_PROVIDER: 'fake-avatar',
      CONTENTOS_FAKE_SPEECH_OUTPUT_PATH: fixtureAudio,
      CONTENTOS_FAKE_AVATAR_OUTPUT_URL: 'http://fake-avatar.test/avatar.mp4',
      CONTENTOS_FAKE_AVATAR_PROXY_URL: `http://127.0.0.1:${fakeAvatarPort}`,
      CONTENTOS_OPERATOR_DIRECT: directOperator ? '1' : '0',
    };
    if (process.env.CONTENTOS_WEB_PRODUCTION === '1') {
      const buildInvocation = pnpmInvocation(['--filter', '@contentos/web', 'exec', 'next', 'build']);
      await run(buildInvocation.command, buildInvocation.args, { ...environment, NODE_ENV: 'production' });
    }
    operator = directOperator
      ? spawn(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), 'scripts/dev-operator.ts'], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true })
      : spawnPnpm(['dev:operator'], environment);
    await waitForHealth(apiUrl);
    const testArgs = ['--test', '--test-concurrency=1'];
    if (process.env.CONTENTOS_BROWSER_TEST_NAME_PATTERN) testArgs.push('--test-name-pattern', process.env.CONTENTOS_BROWSER_TEST_NAME_PATTERN);
    const browserTests = (process.env.CONTENTOS_BROWSER_TEST_FILES || 'tests/e2e/auto-edit-v1-browser.test.ts;tests/e2e/editing-workbench-browser.test.ts;tests/e2e/hybrid-script-edit-browser.test.ts;tests/e2e/script-editing-v2-browser.test.ts;tests/e2e/script-editing-v3-browser.test.ts;tests/e2e/digital-human-browser.test.ts;tests/e2e/production-pipeline-browser.test.ts').split(';').map((file) => file.trim()).filter(Boolean);
    testArgs.push(...browserTests);
    const invocation = directOperator
      ? { command: process.execPath, args: [resolve(root, 'node_modules/tsx/dist/cli.mjs'), ...testArgs] }
      : pnpmInvocation(testArgs);
    const browserExecutable = process.env.CONTENTOS_BROWSER_EXECUTABLE || (process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : undefined);
    await run(invocation.command, invocation.args, {
      ...environment,
      CONTENTOS_OPERATOR_URL: webUrl,
      CONTENTOS_BROWSER_FIXTURE_VIDEO: fixtureVideos[0]!,
      CONTENTOS_BROWSER_FIXTURE_VIDEOS: JSON.stringify(fixtureVideos),
      CONTENTOS_BROWSER_FIXTURE_AUDIO: fixtureAudio,
      CONTENTOS_LOCAL_MEDIA_ROOTS: temporaryRoot,
      CONTENTOS_BROWSER_FIXTURE_DIR: temporaryRoot,
      CONTENTOS_BROWSER_DATABASE_URL: databaseUrl,
      CONTENTOS_OPERATOR_DIRECT: directOperator ? '1' : '0',
      ...(browserExecutable ? { CONTENTOS_BROWSER_EXECUTABLE: browserExecutable } : {}),
    });
  } finally {
    if (operator) await stopOwnedTree(operator);
    if (fakeAvatarServer) await new Promise<void>((resolveClose) => fakeAvatarServer!.close(() => resolveClose()));
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(fakeAvatarRoot, { recursive: true, force: true });
  }
}

await main();
