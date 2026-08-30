import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDatabase, migrateDown, migrateUp, resolveMigrationsDirectory } from '../../packages/database/src/index.js';

const adminUrl =
  process.env.CONTENTOS_TEST_ADMIN_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:5432/contentos_test';
const migrationDirectory = resolveMigrationsDirectory();
const migrationNames = Array.from({ length: 18 }, (_, index) => String(index + 1).padStart(4, '0'));

function schemaUrl(name: string): string {
  const url = new URL(adminUrl);
  url.searchParams.set('options', `-c search_path=${name}`);
  return url.toString();
}

async function createTemporarySchema(): Promise<{ name: string; url: string; drop: () => Promise<void> }> {
  const name = `contentos_matrix_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const admin = new pg.Pool({ connectionString: adminUrl });
  await admin.query(`create schema "${name}"`);
  return {
    name,
    url: schemaUrl(name),
    drop: async () => {
      await admin.query(`drop schema if exists "${name}" cascade`);
      await admin.end();
    },
  };
}

async function migrateSubset(url: string, endAt: number): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'contentos-migration-matrix-'));
  try {
    const names = migrationNames.slice(0, endAt);
    const entries = await readdir(migrationDirectory);
    await Promise.all(
      names.map(async (number) => {
        const file = entries.find((entry) => entry.startsWith(`${number}_`) && !entry.endsWith('.down.sql'));
        assert.ok(file, `migration ${number} exists`);
        await copyFile(join(migrationDirectory, file), join(temp, file));
      }),
    );
    const db = await createDatabase(url);
    try {
      await migrateUp(db, temp);
    } finally {
      await db.end();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

for (const [label, subset] of [
  ['clean', 0],
  ['0001-0005', 5],
  ['0001-0006', 6],
] as const) {
  test(`migration matrix applies full chain from ${label}`, async () => {
    const database = await createTemporarySchema();
    try {
      if (subset > 0) await migrateSubset(database.url, subset);
      const db = await createDatabase(database.url);
      try {
        const result = await migrateUp(db);
        assert.equal(result.applied, 18 - subset);
        const rows = await db.query<{ name: string }>('select name from schema_migrations order by name');
        assert.deepEqual(
          rows.rows.map((row) => row.name.slice(0, 4)),
          migrationNames,
        );
      } finally {
        await db.end();
      }
    } finally {
      await database.drop();
    }
  });
}

test('migration 0016 down restores the legacy project ownership constraints', async () => {
  const database = await createTemporarySchema();
  const temp = await mkdtemp(join(tmpdir(), 'contentos-migration-0016-down-'));
  try {
    const entries = await readdir(migrationDirectory);
    await Promise.all(
      Array.from({ length: 16 }, async (_, index) => {
        const number = String(index + 1).padStart(4, '0');
        await Promise.all(
          entries.filter((entry) => entry.startsWith(`${number}_`)).map((entry) => copyFile(join(migrationDirectory, entry), join(temp, entry))),
        );
      }),
    );
    const db = await createDatabase(database.url);
    try {
      await migrateUp(db, temp);
      const before = await db.query<{ table_name: string; is_nullable: string }>(
        "select table_name, is_nullable from information_schema.columns where table_schema = current_schema() and table_name in ('edit_manifests', 'renders') and column_name = 'project_id' order by table_name",
      );
      assert.deepEqual(before.rows, [
        { table_name: 'edit_manifests', is_nullable: 'YES' },
        { table_name: 'renders', is_nullable: 'YES' },
      ]);
      assert.equal((await migrateDown(db, temp)).removed, 1);
      const after = await db.query<{ table_name: string; is_nullable: string }>(
        "select table_name, is_nullable from information_schema.columns where table_schema = current_schema() and table_name in ('edit_manifests', 'renders') and column_name = 'project_id' order by table_name",
      );
      assert.deepEqual(after.rows, [
        { table_name: 'edit_manifests', is_nullable: 'NO' },
        { table_name: 'renders', is_nullable: 'NO' },
      ]);
    } finally {
      await db.end();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
    await database.drop();
  }
});

test('migration 0016 maps legacy render asset roles into video workspace outputs', async () => {
  const database = await createTemporarySchema();
  const temp = await mkdtemp(join(tmpdir(), 'contentos-migration-0016-legacy-role-'));
  const projectId = `legacy-role-project-${randomUUID()}`;
  const assetId = `legacy-role-asset-${randomUUID()}`;
  try {
    const entries = await readdir(migrationDirectory);
    await Promise.all(
      Array.from({ length: 15 }, async (_, index) => {
        const number = String(index + 1).padStart(4, '0');
        const file = entries.find((entry) => entry.startsWith(`${number}_`) && !entry.endsWith('.down.sql'));
        assert.ok(file, `migration ${number} exists`);
        await copyFile(join(migrationDirectory, file), join(temp, file));
      }),
    );
    const db = await createDatabase(database.url);
    try {
      await migrateUp(db, temp);
      await db.query("insert into content_projects (id, status) values ($1, 'DRAFT')", [projectId]);
      await db.query("insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle) values ($1, $2, 'VIDEO', $3, 1, $4, 'READY')", [
        assetId,
        projectId,
        `checksum-${assetId}`,
        `storage/${assetId}.mp4`,
      ]);
      await db.query("insert into project_assets (project_id, asset_id, role) values ($1, $2, 'RENDER')", [projectId, assetId]);

      await migrateUp(db);

      const rows = await db.query<{ workspace_id: string; asset_id: string; role: string }>(
        'select workspace_id, asset_id, role from video_workspace_assets where asset_id = $1',
        [assetId],
      );
      assert.deepEqual(rows.rows, [{ workspace_id: `workspace-project-${projectId}`, asset_id: assetId, role: 'OUTPUT' }]);
    } finally {
      await db.end();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
    await database.drop();
  }
});
