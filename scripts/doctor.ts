import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const checks: Array<[string, () => Promise<void>]> = [
  ['runtime', async () => { if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(process.version); }],
  ['storage writable', async () => access(process.env.STORAGE_ROOT || './storage/local')],
  ['ffmpeg executable', async () => { await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']); }],
  ['ffprobe executable', async () => { await run(process.env.FFPROBE_PATH || 'ffprobe', ['-version']); }],
  ['ffmpeg filters', async () => { const result = await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-filters']); const output = `${result.stdout}\n${result.stderr}`; for (const filter of ['drawtext', 'scale', 'crop', 'concat']) if (!output.includes(filter)) throw new Error(`missing filter ${filter}`); }],
  ['ffmpeg codecs', async () => { const result = await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-encoders']); const output = `${result.stdout}\n${result.stderr}`; for (const codec of ['libx264', 'aac']) if (!output.includes(codec)) throw new Error(`missing encoder ${codec}`); }],
  ['subtitle font', async () => { const font = process.env.FFMPEG_FONT_FILE || (process.platform === 'win32' ? 'C:\\Windows\\Fonts\\msyh.ttc' : ''); if (font) await access(font); }],
];
let failed = 0;
for (const [name, check] of checks) {
  try { await check(); console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}: ${(error as Error).message}`); }
}
if (failed) process.exit(1);
