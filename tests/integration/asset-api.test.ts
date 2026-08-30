import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';

function multipart(filename: string, contentType: string, content: string | Buffer): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----contentos-${randomUUID()}`;
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, data, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function fixture() {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const project = await new ProjectService(db).create(`Asset API ${randomUUID()}`); const root = `E:/ContentOS/.tmp/asset-api-${randomUUID()}`; const storage = new LocalStorageProvider(root); const app = await buildApi({ db, storage, uploadMaxBytes: 1024 });
  return { db, project, root, storage, app };
}
async function cleanup(data: Awaited<ReturnType<typeof fixture>>): Promise<void> { await data.app.close(); await data.db.query('delete from asset_imports where project_id = $1', [data.project.id]); await data.db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [data.project.id]); await data.db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [data.project.id]); await data.db.query('delete from jobs where project_id = $1', [data.project.id]); await data.db.query('delete from project_assets where project_id = $1', [data.project.id]); await data.db.query('delete from assets where project_id = $1', [data.project.id]); await data.db.query('delete from content_projects where id = $1', [data.project.id]); await data.db.end(); await rm(data.root, { recursive: true, force: true }); }

test('Asset API stages upload, creates one ASSET_IMPORT Job and returns safe summaries', async () => {
  const data = await fixture();
  try {
    const upload = multipart('门店视频.mp4', 'video/mp4', 'not-yet-probed');
    const response = await data.app.inject({ method: 'POST', url: `/api/v1/projects/${data.project.id}/asset-imports`, payload: upload.body, headers: upload.headers });
    assert.equal(response.statusCode, 202, response.body); const body = response.json() as { import: { state: string; originalName: string; jobId: string }; jobId: string }; assert.equal(body.import.state, 'QUEUED'); assert.equal(body.import.jobId, body.jobId); assert.equal(body.import.originalName, '门店视频.mp4');
    const imports = await data.app.inject({ method: 'GET', url: `/api/v1/projects/${data.project.id}/asset-imports` }); assert.equal(imports.statusCode, 200); assert.equal(imports.json().items.length, 1); assert.equal(JSON.stringify(imports.json()).includes('storageKey'), false); assert.equal(JSON.stringify(imports.json()).includes('absolute'), false);
    const jobs = await data.db.query('select id from jobs where project_id = $1 and type = $2', [data.project.id, 'ASSET_IMPORT']); assert.equal(jobs.rowCount, 1);
  } finally { await cleanup(data); }
});

test('Asset API rejects unsupported, empty, traversal and oversized uploads before media work', async () => {
  const data = await fixture();
  try {
    const unsupported = await data.app.inject({ method: 'POST', url: `/api/v1/projects/${data.project.id}/asset-imports`, ...multipart('notes.txt', 'text/plain', 'text') }); assert.equal(unsupported.statusCode, 422); assert.equal(unsupported.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');
    const empty = await data.app.inject({ method: 'POST', url: `/api/v1/projects/${data.project.id}/asset-imports`, ...multipart('empty.mp4', 'video/mp4', '') }); assert.equal(empty.statusCode, 413); assert.equal(empty.json().error.code, 'EMPTY_UPLOAD');
    const traversal = await data.app.inject({ method: 'POST', url: `/api/v1/projects/${data.project.id}/asset-imports`, ...multipart('foo..bar.mp4', 'video/mp4', 'bytes') }); assert.equal(traversal.statusCode, 422); assert.equal(traversal.json().error.code, 'ASSET_IMPORT_FAILED');
    const oversized = await data.app.inject({ method: 'POST', url: `/api/v1/projects/${data.project.id}/asset-imports`, ...multipart('large.mp4', 'video/mp4', 'x'.repeat(2048)) }); assert.equal(oversized.statusCode, 413); assert.equal(oversized.json().error.code, 'UPLOAD_TOO_LARGE');
    assert.equal((await data.db.query('select id from asset_imports where project_id = $1', [data.project.id])).rowCount, 0);
  } finally { await cleanup(data); }
});

test('Asset API lists project-owned assets and streams only READY content', async () => {
  const data = await fixture();
  try {
    const key = 'objects/aa/test.mp4'; const bytes = Buffer.from('ready-content'); await mkdir(dirname(data.storage.objectPath(key)), { recursive: true }); await writeFile(data.storage.objectPath(key), bytes);
    await data.db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', ['asset-api-ready', data.project.id, 'VIDEO_RENDER', 'sha256:' + 'c'.repeat(64), bytes.byteLength, key, 'READY', { originalName: 'ready.mp4', format: 'mp4' }]);
    await data.db.query('insert into project_assets (project_id, asset_id, role) values ($1, $2, $3)', [data.project.id, 'asset-api-ready', 'OUTPUT']);
    const list = await data.app.inject({ method: 'GET', url: `/api/v1/projects/${data.project.id}/assets` }); assert.equal(list.statusCode, 200); assert.equal(list.json().items[0].id, 'asset-api-ready'); assert.equal('storageKey' in list.json().items[0], false); assert.equal('storage_key' in list.json().items[0], false);
    const content = await data.app.inject({ method: 'GET', url: `/api/v1/projects/${data.project.id}/assets/asset-api-ready/content` }); assert.equal(content.statusCode, 200); assert.equal(content.headers['accept-ranges'], 'bytes'); assert.equal(content.headers.etag, '"sha256:' + 'c'.repeat(64) + '"'); assert.equal(content.body, 'ready-content');
    const missing = await data.app.inject({ method: 'GET', url: `/api/v1/projects/${data.project.id}/assets/missing/content` }); assert.equal(missing.statusCode, 404);
  } finally { await cleanup(data); }
});
