import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDatabase, migrateUp, resolveMigrationsDirectory } from '../../packages/database/src/index.js';

const adminUrl = process.env.CONTENTOS_TEST_ADMIN_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:5432/contentos_test';
const migrationDirectory = resolveMigrationsDirectory();
const migrationNames = Array.from({ length: 16 }, (_, index) => String(index + 1).padStart(4, '0'));

function schemaUrl(name: string): string {
  const url = new URL(adminUrl);
  url.searchParams.set('options', `-c search_path=${name}`);
  return url.toString();
}

async function createTemporarySchema(): Promise<{ name: string; url: string; drop: () => Promise<void> }> {
  const name = `contentos_matrix_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const admin = new pg.Pool({ connectionString: adminUrl });
  await admin.query(`create schema "${name}"`);
  return { name, url: schemaUrl(name), drop: async () => { await admin.query(`drop schema if exists "${name}" cascade`); await admin.end(); } };
}

async function migrateSubset(url: string, endAt: number): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'contentos-migration-matrix-'));
  try {
    const names = migrationNames.slice(0, endAt);
    const entries = await readdir(migrationDirectory);
    await Promise.all(names.map(async (number) => {
      const file = entries.find((entry) => entry.startsWith(`${number}_`) && !entry.endsWith('.down.sql'));
      assert.ok(file, `migration ${number} exists`);
      await copyFile(join(migrationDirectory, file), join(temp, file));
    }));
    const db = await createDatabase(url);
    try { await migrateUp(db, temp); } finally { await db.end(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
}

for (const [label, subset] of [['clean', 0], ['0001-0005', 5], ['0001-0006', 6]] as const) {
  test(`migration matrix applies full chain from ${label}`, async () => {
    const database = await createTemporarySchema();
    try {
      if (subset > 0) await migrateSubset(database.url, subset);
      const db = await createDatabase(database.url);
      try {
        const result = await migrateUp(db);
        assert.equal(result.applied, 16 - subset);
        const rows = await db.query<{ name: string }>('select name from schema_migrations order by name');
        assert.deepEqual(rows.rows.map((row) => row.name.slice(0, 4)), migrationNames);
      } finally { await db.end(); }
    } finally { await database.drop(); }
  });
}
