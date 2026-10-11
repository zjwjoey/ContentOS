import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, rmdir, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { PostgresRuntimeManager } from '../../packages/runtime-core/src/postgres/postgres-manager.js';

for (const unicodeData of [false, true]) test(`Windows bundled PostgreSQL supports Unicode resources with ${unicodeData ? 'Unicode' : 'ASCII'} data and preserves data across restart`, { skip: process.platform !== 'win32', timeout: 150_000 }, async () => {
  const testRoot = resolve('.test-results'); await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'postgres-中文路径-'));
  const require = createRequire(import.meta.url);
  const native = resolve(dirname(require.resolve('embedded-postgres')), '../../@embedded-postgres/windows-x64/native');
  const resourcesRoot = join(root, '资源'); await mkdir(resourcesRoot, { recursive: true });
  const resourceLink = join(resourcesRoot, 'postgres'); await symlink(native, resourceLink, 'junction');
  const reservation = createServer(); await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const dataRoot = unicodeData ? join(root, '数据库') : await mkdtemp(join(tmpdir(), 'contentos-pg-resource-test-'));
  const options = { resourcesRoot, dataRoot, port, user: 'postgres', password: 'unicode-fixture-only', database: 'contentos_test', stopTimeoutMs: 5_000 };
  let manager = new PostgresRuntimeManager(options);
  try {
    await manager.start();
    const client = new pg.Client({ connectionString: manager.connectionUrl(), connectionTimeoutMillis: 5_000, query_timeout: 10_000 }); await client.connect();
    await client.query('create table fixture(value text)'); await client.query('insert into fixture values($1)', ['中文数据保持完整']); await client.end();
    assert.equal((await manager.healthCheck()).state, 'READY');
    await manager.stop(); assert.equal((await manager.healthCheck()).state, 'FAILED');
    manager = new PostgresRuntimeManager(options); await manager.start();
    const restarted = new pg.Client({ connectionString: manager.connectionUrl(), connectionTimeoutMillis: 5_000, query_timeout: 10_000 }); await restarted.connect();
    assert.equal((await restarted.query('select value from fixture')).rows[0].value, '中文数据保持完整'); await restarted.end();
  } finally {
    await manager.stop();
    await rmdir(resourceLink);
    assert.ok(root.startsWith(`${testRoot}${sep}`), 'cleanup stays in isolated test root');
    await rm(root, { recursive: true, force: true });
    if (!unicodeData) {
      assert.ok(dataRoot.startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(dataRoot, { recursive: true, force: true });
    }
    await access(join(native, 'bin', 'postgres.exe'));
  }
});

