import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { AssetCatalogService, AssetService } from '../../packages/modules/asset/src/index.js';
import { DigitalHumanService } from '../../packages/modules/digital-human/src/index.js';
import { JobRunner, JobService } from '../../packages/modules/job/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { generateFixtureAudio, generateFixtureVideo, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
import type { AvatarProvider } from '../../packages/contracts/src/index.js';
import { createDigitalHumanJobHandler } from '../../workers/digital-human-worker/src/handler.js';

const adminUrl = process.env.CONTENTOS_TEST_ADMIN_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test';
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';

async function temporaryDatabase(): Promise<{ url: string; close: () => Promise<void> }> {
  const schema = `contentos_dh_worker_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const admin = new pg.Pool({ connectionString: adminUrl });
  await admin.query(`create schema "${schema}"`);
  const url = new URL(adminUrl); url.searchParams.set('options', `-c search_path=${schema}`);
  return { url: url.toString(), close: async () => { await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end(); } };
}

test('Digital Human Worker imports a remote avatar result into a project Asset', async () => {
  const temporary = await temporaryDatabase(); const root = await mkdtemp(join(tmpdir(), 'contentos-digital-human-worker-')); const db = await createDatabase(temporary.url);
  const server = createServer((request, response) => { if (request.url === '/avatar.mp4') { response.writeHead(200, { 'content-type': 'video/mp4' }); createReadStream(join(root, 'remote.mp4')).pipe(response); return; } response.writeHead(404).end(); });
  try {
    await migrateUp(db); await mkdir(join(root, 'storage'), { recursive: true });
    const address = await new Promise<{ port: number }>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address(); if (!value || typeof value === 'string') return reject(new Error('Worker test server did not expose a port')); resolve({ port: value.port }); }); });
    const project = await new ProjectService(db).create(`Digital Human Worker ${randomUUID()}`); const storage = new LocalStorageProvider(join(root, 'storage')); const catalog = new AssetCatalogService(db); const assets = new AssetService(db, storage, (path) => probeMedia(path, ffprobePath)); const jobs = new JobService(db); const digitalHuman = new DigitalHumanService(db, jobs, catalog);
    await generateFixtureVideo(join(root, 'clip.mp4'), ffmpegPath, 'blue', 2); await generateFixtureVideo(join(root, 'remote.mp4'), ffmpegPath, 'green', 2); await generateFixtureAudio(join(root, 'speech.wav'), ffmpegPath);
    const clipAsset = await assets.importFile({ projectId: project.id, sourcePath: join(root, 'clip.mp4'), kind: 'VIDEO', role: 'SOURCE' }); const speechAsset = await assets.importFile({ projectId: project.id, sourcePath: join(root, 'speech.wav'), kind: 'AUDIO', role: 'OUTPUT' });
    const avatar = await digitalHuman.createAvatarProfile({ projectId: project.id, name: 'Worker Test Avatar', status: 'READY' }); const clip = await digitalHuman.createAvatarClip({ projectId: project.id, avatarProfileId: avatar.id, assetId: clipAsset.id, name: 'Blue Clip', durationMs: 2_000 });
    const created = await digitalHuman.createAvatarGeneration({ projectId: project.id, avatarProfileId: avatar.id, avatarClipId: clip.id, speechAssetId: speechAsset.id, provider: 'test-avatar', correlationId: 'worker-integration' });
    const avatarProvider: AvatarProvider = { providerId: 'test-avatar', getCapabilities: async () => ({ providerId: 'test-avatar', local: false, videoToVideo: true, imageToVideo: false, requiresPublicUrl: true, supportedFormats: ['mp4'] }), submitLipSync: async () => ({ externalTaskId: 'remote-worker-1', providerId: 'test-avatar', status: 'SUCCEEDED', outputUrl: `http://127.0.0.1:${address.port}/avatar.mp4`, model: 'test-model', modelVersion: 'test-1', costAmount: 3.15, costCurrency: 'RMB', billingQuantity: 63, billingUnit: 'second' }), getTask: async () => ({ externalTaskId: 'remote-worker-1', providerId: 'test-avatar', status: 'SUCCEEDED', outputUrl: `http://127.0.0.1:${address.port}/avatar.mp4`, costAmount: 3.15, costCurrency: 'RMB', billingQuantity: 63, billingUnit: 'second' }) };
    const result = await new JobRunner(jobs, 'digital-human-worker-integration').run(created.job.id, createDigitalHumanJobHandler({ jobs, digitalHuman, assets: catalog, assetService: assets, storage, speechProvider: {} as never, avatarProvider, staging: { stageAsset: async (assetId) => ({ publicUrl: `https://staging.test/${assetId}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }) } }));
    assert.equal(result.state, 'SUCCEEDED', JSON.stringify(result)); const generation = await digitalHuman.getAvatarGeneration(project.id, created.generation.id); assert.equal(generation?.status, 'SUCCEEDED'); assert.ok(generation?.outputAssetId); assert.notEqual(generation?.outputAssetId, clipAsset.id); assert.equal(generation?.externalTaskId, 'remote-worker-1'); assert.equal(generation?.costAmount, 3.15); assert.equal(generation?.costCurrency, 'RMB'); assert.equal(generation?.billingQuantity, 63); assert.equal(generation?.billingUnit, 'second');
    const output = await catalog.getProjectAsset(project.id, generation!.outputAssetId!); assert.equal(output?.kind, 'VIDEO'); assert.equal(output?.lifecycle, 'READY'); assert.equal(output?.metadata.format, 'mp4'); assert.ok(Number(output?.metadata.durationMs) > 0);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await db.end(); await temporary.close(); await rm(root, { recursive: true, force: true }); }
});
