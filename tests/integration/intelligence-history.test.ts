import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { MediaIntelligenceService, createFakeIntelligenceProviders } from '../../packages/modules/intelligence/src/index.js';

test('persisted analysis history survives service recreation and pages without loss across projects and microsecond timestamps', async () => {
  const url = process.env.CONTENTOS_TEST_DATABASE_URL;
  assert.ok(url); assert.equal(new URL(url).pathname, '/contentos_test');
  const admin = await createDatabase(url); const schema = `history_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`);
  const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
  const db = await createDatabase(scoped.toString());
  try {
    await migrateUp(db);
    const projects = new ProjectService(db); const project = await projects.create('Persisted history'); const other = await projects.create('Separate project');
    const assetId = `asset-${randomUUID()}`;
    await db.query("insert into assets(id,project_id,kind,checksum,byte_size,storage_key,lifecycle,metadata) values($1,$2,'VIDEO','fixture',1,'fixture.mp4','READY','{}')", [assetId, project.id]);
    const service = new MediaIntelligenceService(db, createFakeIntelligenceProviders());
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const run = await service.createRun({ projectId: project.id, assetId, idempotencyKey: `history-${i}` }); ids.push(run.id);
      await db.query('update media_analysis_runs set created_at=$2 where id=$1', [run.id, `2026-10-11T00:00:00.00100${i}Z`]);
    }
    const recreated = new MediaIntelligenceService(db, createFakeIntelligenceProviders());
    const first = await recreated.listRuns(project.id, { limit: 2 }); assert.ok(first.nextCursor);
    const second = await recreated.listRuns(project.id, { limit: 2, cursor: first.nextCursor });
    assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.items, ...second.items].map((run) => run.id), [...ids].reverse());
    assert.deepEqual((await recreated.listRuns(other.id)).items, []);
    await assert.rejects(recreated.listRuns(project.id, { cursor: 'invalid' }), /CURSOR_INVALID/);
    await assert.rejects(recreated.listRuns(project.id, { limit: 101 }), /LIMIT_INVALID/);
  } finally { await db.end(); await admin.query(`drop schema "${schema}" cascade`); await admin.end(); }
});
