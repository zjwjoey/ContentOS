import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const root = resolve(import.meta.dirname, '../../..');
const source = resolve(root, 'apps/desktop/src/renderer/failure.html');
const target = resolve(root, 'dist/apps/desktop/src/renderer/failure.html');
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`Copied ${source} -> ${target}`);
const startupSource = resolve(root, 'apps/desktop/src/renderer/startup.html');
const startupTarget = resolve(root, 'dist/apps/desktop/src/renderer/startup.html');
await copyFile(startupSource, startupTarget);
console.log(`Copied ${startupSource} -> ${startupTarget}`);

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  return await new Promise((resolveHash, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function commandVersion(file: string, args: string[], pattern: RegExp): Promise<string | undefined> {
  try {
    const result = await execFileAsync(file, args, { windowsHide: true, timeout: 10_000 });
    return `${result.stdout}\n${result.stderr}`.match(pattern)?.[1];
  } catch { return undefined; }
}

async function sourceCommit(): Promise<string | undefined> {
  try { return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, timeout: 5_000 })).stdout.trim() || undefined; }
  catch { return undefined; }
}

async function stageWindowsResources(): Promise<void> {
  if (process.platform !== 'win32') {
    if (process.env.CONTENTOS_DESKTOP_PACKAGE === '1') throw new Error('Windows Desktop packaging must run on win32-x64');
    return;
  }
  const require = createRequire(import.meta.url);
  const ffmpegSource = require.resolve('ffmpeg-static/ffmpeg.exe');
  const ffprobeSource = require.resolve('ffprobe-static/bin/win32/x64/ffprobe.exe');
  const embeddedEntry = require.resolve('embedded-postgres');
  const postgresSource = resolve(dirname(embeddedEntry), '..', '..', '@embedded-postgres', 'windows-x64', 'native');
  await stat(resolve(postgresSource, 'bin', 'postgres.exe'));
  const resourcesRoot = resolve(root, 'apps/desktop/resources');
  const postgresTarget = resolve(resourcesRoot, 'postgres');
  const ffmpegTargetRoot = resolve(resourcesRoot, 'ffmpeg');
  await rm(postgresTarget, { recursive: true, force: true });
  await rm(ffmpegTargetRoot, { recursive: true, force: true });
  await mkdir(resourcesRoot, { recursive: true });
  await cp(postgresSource, postgresTarget, { recursive: true });
  await mkdir(ffmpegTargetRoot, { recursive: true });
  await copyFile(ffmpegSource, resolve(ffmpegTargetRoot, 'ffmpeg.exe'));
  await copyFile(ffprobeSource, resolve(ffmpegTargetRoot, 'ffprobe.exe'));
  const template = JSON.parse(await readFile(resolve(resourcesRoot, 'resources-manifest.json'), 'utf8')) as Record<string, unknown>;
  const [postgresVersion, ffmpegVersion, ffprobeVersion, commitSha] = await Promise.all([
    commandVersion(resolve(postgresTarget, 'bin', 'postgres.exe'), ['--version'], /PostgreSQL\)?\s+([0-9]+(?:\.[0-9]+){1,2})/u),
    commandVersion(resolve(ffmpegTargetRoot, 'ffmpeg.exe'), ['-version'], /ffmpeg version\s+([^\s]+)/u),
    commandVersion(resolve(ffmpegTargetRoot, 'ffprobe.exe'), ['-version'], /ffprobe version\s+([^\s]+)/u),
    sourceCommit(),
  ]);
  const runtimeManifest = {
    ...template,
    ...(commitSha ? { commitSha } : {}),
    generatedAt: new Date().toISOString(),
    postgres: { ...(template.postgres as Record<string, unknown>), ...(postgresVersion ? { version: postgresVersion } : {}) },
    ffmpeg: { ...(template.ffmpeg as Record<string, unknown>), ...(ffmpegVersion ? { version: ffmpegVersion } : {}) },
    ffprobe: { ...(template.ffprobe as Record<string, unknown>), ...(ffprobeVersion ? { version: ffprobeVersion } : {}) },
    files: {
      postgres: {
        postgres: { relativePath: 'postgres/bin/postgres.exe', sha256: await sha256(resolve(postgresTarget, 'bin', 'postgres.exe')) },
        pgCtl: { relativePath: 'postgres/bin/pg_ctl.exe', sha256: await sha256(resolve(postgresTarget, 'bin', 'pg_ctl.exe')) },
        initdb: { relativePath: 'postgres/bin/initdb.exe', sha256: await sha256(resolve(postgresTarget, 'bin', 'initdb.exe')) },
      },
      ffmpeg: { relativePath: 'ffmpeg/ffmpeg.exe', sha256: await sha256(resolve(ffmpegTargetRoot, 'ffmpeg.exe')) },
      ffprobe: { relativePath: 'ffmpeg/ffprobe.exe', sha256: await sha256(resolve(ffmpegTargetRoot, 'ffprobe.exe')) },
    },
  };
  await writeFile(resolve(resourcesRoot, 'runtime-manifest.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`, 'utf8');
  console.log(`Staged Windows runtime resources under ${resourcesRoot}`);
}

await stageWindowsResources();
