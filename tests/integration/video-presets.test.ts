import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { generateFixtureVideo } from '../../packages/infrastructure/ffmpeg/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test';

function multipart(filename: string, contentType: string, content: Buffer): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----contentos-${randomUUID()}`;
  return { body: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

test('video presets persist, become default, and are remembered by a project', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const app = await buildApi({ db }); const name = `验收模板 ${randomUUID()}`; let projectId = '';
  try {
  const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: `模板验收项目 ${randomUUID()}` } }); assert.equal(project.statusCode, 201); projectId = project.json().id;
    const globalAssetId = `preset-branding-${randomUUID()}`;
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, null, $2, $3, $4, $5, $6, $7)', [globalAssetId, 'VIDEO', `checksum-${globalAssetId}`, 1, `global/${globalAssetId}.mp4`, 'READY', { originalName: 'MIZAN-logo.mp4', durationMs: 2000 }]);
    const globalAssets = await app.inject({ method: 'GET', url: '/api/v1/video/preset-assets' }); assert.equal(globalAssets.statusCode, 200); assert.equal(globalAssets.json().items.some((item: { id: string; originalName: string }) => item.id === globalAssetId && item.originalName === 'MIZAN-logo.mp4'), true);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/video/presets' }); assert.equal(listed.statusCode, 200); assert.ok(listed.json().items.some((item: { name: string }) => item.name === 'MIZAN 门店口播'));
    const created = await app.inject({ method: 'POST', url: '/api/v1/video/presets', payload: { name, description: '测试模板', editModeDefault: 'RANDOM', minClipDurationMs: 1800, maxClipDurationMs: 4200, preferUnusedMedia: true } }); assert.equal(created.statusCode, 201); const presetId = created.json().id;
    const updated = await app.inject({ method: 'PATCH', url: `/api/v1/video/presets/${presetId}`, payload: { description: '已更新模板' } }); assert.equal(updated.statusCode, 200); assert.equal(updated.json().description, '已更新模板');
    const defaulted = await app.inject({ method: 'POST', url: `/api/v1/video/presets/${presetId}/default` }); assert.equal(defaulted.statusCode, 200); assert.equal(defaulted.json().isDefault, true);
    const applied = await app.inject({ method: 'PUT', url: `/api/v1/projects/${projectId}/video/preset`, payload: { presetId } }); assert.equal(applied.statusCode, 200); const current = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/video/preset` }); assert.equal(current.statusCode, 200); assert.equal(current.json().preset.id, presetId);
    const deletedDefault = await app.inject({ method: 'DELETE', url: `/api/v1/video/presets/${presetId}` }); assert.equal(deletedDefault.statusCode, 409);
    const removedDefault = await app.inject({ method: 'POST', url: '/api/v1/video/presets/preset-mizan-store/default' }); assert.equal(removedDefault.statusCode, 200); const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/video/presets/${presetId}` }); assert.equal(deleted.statusCode, 200);
  } finally { if (projectId) await db.query('delete from content_projects where id = $1', [projectId]); await db.query("delete from assets where id like 'preset-branding-%'"); await app.close(); await db.end(); }
});

test('global branding upload enters the picker and cannot be archived while referenced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-video-presets-')); const db = await createDatabase(databaseUrl); await migrateUp(db); const storage = new LocalStorageProvider(join(root, 'storage')); const app = await buildApi({ db, storage }); const fixture = join(root, 'MIZAN-logo.mp4'); const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'; let assetId = ''; let presetId = '';
  try {
    await generateFixtureVideo(fixture, ffmpegPath, 'black', 1);
    const upload = await app.inject({ method: 'POST', url: '/api/v1/video/preset-assets', ...multipart('MIZAN-logo.mp4', 'video/mp4', await readFile(fixture)) }); assert.equal(upload.statusCode, 201, upload.body); assetId = upload.json().asset.id;
    const listed = await app.inject({ method: 'GET', url: '/api/v1/video/preset-assets' }); assert.equal(listed.statusCode, 200); assert.equal(listed.json().items.find((item: { id: string }) => item.id === assetId).originalName, 'MIZAN-logo.mp4'); assert.ok(listed.json().items.find((item: { id: string }) => item.id === assetId).durationMs > 0);
    const preset = await app.inject({ method: 'POST', url: '/api/v1/video/presets', payload: { name: `品牌上传验收 ${randomUUID()}`, description: '品牌上传验收', editModeDefault: 'SCRIPT', introAssetId: assetId } }); assert.equal(preset.statusCode, 201, preset.body); presetId = preset.json().id;
    const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/video/preset-assets/${assetId}` }); assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().error.message, '这个视频正在被剪辑模板使用，请先从模板中移除。');
    const cleared = await app.inject({ method: 'PATCH', url: `/api/v1/video/presets/${presetId}`, payload: { introAssetId: null } }); assert.equal(cleared.statusCode, 200, cleared.body);
    const archived = await app.inject({ method: 'DELETE', url: `/api/v1/video/preset-assets/${assetId}` }); assert.equal(archived.statusCode, 200, archived.body); assert.equal((await app.inject({ method: 'GET', url: '/api/v1/video/preset-assets' })).json().items.some((item: { id: string }) => item.id === assetId), false);
  } finally { if (presetId) await db.query('delete from video_edit_presets where id = $1', [presetId]); if (assetId) await db.query('delete from assets where id = $1', [assetId]); await app.close(); await db.end(); await rm(root, { recursive: true, force: true }); }
});
