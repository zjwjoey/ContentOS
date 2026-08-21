import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from './client.js';

const migrationsDirectory = join(process.cwd(), 'migrations');

export async function migrateUp(db: Database): Promise<{ applied: number }> {
  const client = await db.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('contentos:migrations'))");
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const files = (await readdir(migrationsDirectory)).filter((file) => /^\d+_.+\.sql$/.test(file) && !file.endsWith('.down.sql')).sort();
    let applied = 0;
    for (const file of files) {
      const existing = await client.query('select 1 from schema_migrations where name = $1', [file]);
      if (existing.rowCount) continue;
      await client.query('begin');
      try {
        await client.query(await readFile(join(migrationsDirectory, file), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        applied += 1;
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
    return { applied };
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('contentos:migrations'))");
    client.release();
  }
}

export async function migrateDown(db: Database): Promise<{ removed: number }> {
  const client = await db.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('contentos:migrations'))");
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const latest = await client.query<{ name: string }>('select name from schema_migrations order by name desc limit 1');
    const name = latest.rows[0]?.name;
    if (!name) return { removed: 0 };
    const downFile = join(migrationsDirectory, name.replace(/\.sql$/, '.down.sql'));
    await client.query('begin');
    try {
      await client.query(await readFile(downFile, 'utf8'));
      await client.query('delete from schema_migrations where name = $1', [name]);
      await client.query('commit');
      return { removed: 1 };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  } catch (error) {
    throw error;
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('contentos:migrations'))");
    client.release();
  }
}
