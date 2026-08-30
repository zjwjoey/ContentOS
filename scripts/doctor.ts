import { access, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';

const run = promisify(execFile);
const checks: Array<[string, () => Promise<void>]> = [
  [
    'runtime',
    async () => {
      if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(process.version);
    },
  ],
  [
    'storage writable',
    async () => {
      const root = resolve(process.env.STORAGE_ROOT || './storage/local');
      await access(root);
      const temp = await mkdtemp(join(root, '.doctor-'));
      const marker = join(temp, 'write-test');
      try {
        await writeFile(marker, 'contentos-doctor');
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
  ],
  [
    'ffmpeg executable',
    async () => {
      await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']);
    },
  ],
  [
    'ffprobe executable',
    async () => {
      await run(process.env.FFPROBE_PATH || 'ffprobe', ['-version']);
    },
  ],
  [
    'ffmpeg filters',
    async () => {
      const result = await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-filters']);
      const output = `${result.stdout}\n${result.stderr}`;
      for (const filter of ['drawtext', 'scale', 'crop', 'concat']) if (!output.includes(filter)) throw new Error(`missing filter ${filter}`);
    },
  ],
  [
    'ffmpeg codecs',
    async () => {
      const result = await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-encoders']);
      const output = `${result.stdout}\n${result.stderr}`;
      for (const codec of ['libx264', 'aac']) if (!output.includes(codec)) throw new Error(`missing encoder ${codec}`);
    },
  ],
  [
    'subtitle font',
    async () => {
      const font = process.env.FFMPEG_FONT_FILE || (process.platform === 'win32' ? 'C:\\Windows\\Fonts\\msyh.ttc' : '');
      if (font) await access(font);
    },
  ],
  [
    'postgres reachable',
    async () => {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error('DATABASE_URL is required for doctor');
      const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3_000, max: 1 });
      try {
        await pool.query('select 1');
      } finally {
        await pool.end();
      }
    },
  ],
  [
    'migration state current',
    async () => {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error('DATABASE_URL is required for doctor');
      const migrationFiles = (await readdir(resolve('migrations'))).filter((file) => /^\d+_.+\.sql$/.test(file) && !file.endsWith('.down.sql')).sort();
      const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3_000, max: 1 });
      try {
        const result = await pool.query<{ name: string }>('select name from schema_migrations order by name');
        const applied = result.rows.map((row) => row.name);
        if (applied.length !== migrationFiles.length || applied.some((name, index) => name !== migrationFiles[index]))
          throw new Error(`expected ${migrationFiles.length} migrations, found ${applied.length}`);
      } finally {
        await pool.end();
      }
    },
  ],
];
let failed = 0;
for (const [name, check] of checks) {
  try {
    await check();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${(error as Error).message}`);
  }
}
if (failed) process.exit(1);
