import { access, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const resourcesRoot = process.env.CONTENTOS_RESOURCES_ROOT || resolve(root, 'apps/desktop/resources');
const required = [
  resolve(root, 'dist/apps/desktop/src/main/main.js'),
  resolve(root, 'dist/apps/desktop/src/main/preload.js'),
  resolve(root, 'dist/apps/desktop/src/renderer/failure.html'),
  resolve(root, 'dist/apps/desktop/src/renderer/startup.html'),
  resolve(resourcesRoot, 'resources-manifest.json'),
  resolve(resourcesRoot, 'runtime-manifest.json'),
  resolve(root, 'dist/apps/runtime-host/src/main.js'),
  resolve(root, 'migrations'),
  resolve(resourcesRoot, 'postgres/bin/postgres.exe'),
  resolve(resourcesRoot, 'postgres/bin/pg_ctl.exe'),
  resolve(resourcesRoot, 'postgres/bin/initdb.exe'),
  resolve(resourcesRoot, 'postgres/lib'),
  resolve(resourcesRoot, 'postgres/share'),
  resolve(resourcesRoot, 'ffmpeg/ffmpeg.exe'),
  resolve(resourcesRoot, 'ffmpeg/ffprobe.exe'),
];
const failures: string[] = [];
for (const item of required) { try { await stat(item); } catch { failures.push(`${item}: missing`); } }
try { await access(resolve(root, 'apps/web/.next')); } catch { failures.push('apps/web/.next: missing; packaged Web requires a production Next build'); }

async function commandVersion(file: string, args: string[], id: string): Promise<string> {
  try { const result = await run(file, args, { timeout: 10_000, windowsHide: true }); return `${id}: ${`${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/u)[0]}`; }
  catch (error) { failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); return ''; }
}

const ffmpegVersion = await commandVersion(resolve(resourcesRoot, 'ffmpeg/ffmpeg.exe'), ['-version'], 'ffmpeg');
const ffprobeVersion = await commandVersion(resolve(resourcesRoot, 'ffmpeg/ffprobe.exe'), ['-version'], 'ffprobe');
const postgresVersion = await commandVersion(resolve(resourcesRoot, 'postgres/bin/postgres.exe'), ['--version'], 'postgres');
if (ffmpegVersion) {
  try {
    const result = await run(resolve(resourcesRoot, 'ffmpeg/ffmpeg.exe'), ['-hide_banner', '-encoders'], { timeout: 10_000, windowsHide: true });
    const output = `${result.stdout}\n${result.stderr}`;
    if (!/(^|\s)libx264(\s|$)/mu.test(output)) failures.push('ffmpeg: libx264 encoder missing');
    if (!/(^|\s)aac(\s|$)/mu.test(output)) failures.push('ffmpeg: aac encoder missing');
  } catch { failures.push('ffmpeg: encoder probe failed'); }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, reject) => { const stream = createReadStream(file); stream.on('data', (chunk) => hash.update(chunk)); stream.on('error', reject); stream.on('end', () => resolveHash()); });
  return hash.digest('hex');
}

try {
  const manifest = JSON.parse(await readFile(resolve(resourcesRoot, 'runtime-manifest.json'), 'utf8')) as { files?: Record<string, unknown> };
  const files = manifest.files as { postgres?: { postgres?: { sha256?: string } }; ffmpeg?: { sha256?: string }; ffprobe?: { sha256?: string } } | undefined;
  const expected = [
    [resolve(resourcesRoot, 'postgres/bin/postgres.exe'), files?.postgres?.postgres?.sha256],
    [resolve(resourcesRoot, 'ffmpeg/ffmpeg.exe'), files?.ffmpeg?.sha256],
    [resolve(resourcesRoot, 'ffmpeg/ffprobe.exe'), files?.ffprobe?.sha256],
  ] as const;
  for (const [file, checksum] of expected) { if (!checksum) { failures.push(`${file}: manifest checksum missing`); continue; } if (await sha256(file) !== checksum) failures.push(`${file}: manifest checksum mismatch`); }
} catch (error) { failures.push(`runtime-manifest: ${error instanceof Error ? error.message : String(error)}`); }

const report = { ok: failures.length === 0, root, resourcesRoot, required, ffmpegVersion, ffprobeVersion, postgresVersion, failures };
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
