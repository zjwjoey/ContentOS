import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApi } from '../../apps/api/src/app.js';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { generateFixtureAudio, generateFixtureVideo, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { AssetCatalogService, AssetService } from '../../packages/modules/asset/src/index.js';
import { DigitalHumanService } from '../../packages/modules/digital-human/src/index.js';
import { JobRunner, JobService } from '../../packages/modules/job/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { VideoService } from '../../packages/modules/video/src/index.js';
import { createVideoJobHandler } from '../../workers/video-worker/src/video-handler.js';

const adminUrl = process.env.CONTENTOS_TEST_ADMIN_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test';
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';

async function temporaryDatabase(): Promise<{ url: string; close: () => Promise<void> }> {
  const schema = `contentos_dh_render_${randomUUID().replaceAll('-', '').slice(0, 20)}`; const admin = new pg.Pool({ connectionString: adminUrl }); await admin.query(`create schema "${schema}"`);
  const url = new URL(adminUrl); url.searchParams.set('options', `-c search_path=${schema}`); return { url: url.toString(), close: async () => { await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end(); } };
}

test('Digital Human handoff renders a final vertical MP4 through the existing Video Worker', async () => {
  const temporary = await temporaryDatabase(); const db = await createDatabase(temporary.url); const root = await mkdtemp(join(tmpdir(), 'contentos-digital-human-render-')); let app: Awaited<ReturnType<typeof buildApi>> | undefined;
  try {
    await migrateUp(db); const project = await new ProjectService(db).create(`Digital Human render ${randomUUID()}`); const storage = new LocalStorageProvider(join(root, 'storage')); const jobs = new JobService(db); const catalog = new AssetCatalogService(db); const assets = new AssetService(db, storage, (path) => probeMedia(path, ffprobePath));
    await generateFixtureVideo(join(root, 'clip.mp4'), ffmpegPath, 'green', 5); await generateFixtureVideo(join(root, 'avatar.mp4'), ffmpegPath, 'blue', 5); await generateFixtureAudio(join(root, 'speech.wav'), ffmpegPath);
    const clipAsset = await assets.importFile({ projectId: project.id, sourcePath: join(root, 'clip.mp4'), kind: 'VIDEO', role: 'SOURCE' }); const avatarAsset = await assets.importFile({ projectId: project.id, sourcePath: join(root, 'avatar.mp4'), kind: 'VIDEO', role: 'OUTPUT' }); const speechAsset = await assets.importFile({ projectId: project.id, sourcePath: join(root, 'speech.wav'), kind: 'AUDIO', role: 'OUTPUT' });
    const clipStored = await catalog.getProjectAsset(project.id, clipAsset.id); const avatarStored = await catalog.getProjectAsset(project.id, avatarAsset.id); const speechStored = await catalog.getProjectAsset(project.id, speechAsset.id); assert.ok(clipStored && avatarStored && speechStored);
    const digitalHuman = new DigitalHumanService(db, jobs, catalog); const voice = await digitalHuman.createVoiceProfile({ projectId: project.id, name: 'Render Voice', provider: 'fake-speech', status: 'READY' }); const speech = await digitalHuman.createSpeechGeneration({ projectId: project.id, voiceProfileId: voice.id, text: '数字人渲染验收。', provider: 'fake-speech', correlationId: 'render-speech' });
    assert.equal(await digitalHuman.completeSpeech(speech.generation.id, { outputAssetId: speechAsset.id, durationMs: Number(speechStored.metadata.durationMs), latencyMs: 1, modelVersion: 'fake-1', provenance: { provider: 'fake-speech' } }), true);
    const avatar = await digitalHuman.createAvatarProfile({ projectId: project.id, name: 'Render Avatar', status: 'READY' }); const clip = await digitalHuman.createAvatarClip({ projectId: project.id, avatarProfileId: avatar.id, assetId: clipAsset.id, name: 'Render Clip' }); const generation = await digitalHuman.createAvatarGeneration({ projectId: project.id, avatarProfileId: avatar.id, avatarClipId: clip.id, speechAssetId: speechAsset.id, provider: 'fake-avatar', correlationId: 'render-avatar' });
    assert.equal(await digitalHuman.completeAvatar(generation.generation.id, { outputAssetId: avatarAsset.id, durationMs: Number(avatarStored.metadata.durationMs), model: 'fake-avatar', modelVersion: '1', provenance: { provider: 'fake-avatar' } }), true);
    app = await buildApi({ db, storage, digitalHumanProviders: { speech: {}, avatar: {}, staging: {}, mediaStagingConfigured: true } as never }); await app.ready();
    const handoff = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/digital-human/avatar-generations/${generation.generation.id}/edit-manifest`, payload: {} }); assert.equal(handoff.statusCode, 201, handoff.body); const handoffBody = handoff.json() as { jobId: string; manifestId: string };
    const video = new VideoService(db, storage, jobs, catalog); const renderJob = await new JobRunner(jobs, 'digital-human-render-test').run(handoffBody.jobId, createVideoJobHandler({ db, storage, assets, jobs, video, ffmpegPath, ffprobePath, fontFile: process.env.FFMPEG_FONT_FILE || 'C:\\Windows\\Fonts\\msyh.ttc' }));
    assert.equal(renderJob.state, 'SUCCEEDED', JSON.stringify(renderJob)); const outputAssetId = (renderJob.result as { outputAssetId?: string } | null)?.outputAssetId; assert.ok(outputAssetId);
    const output = await catalog.getProjectAsset(project.id, outputAssetId!); assert.equal(output?.kind, 'VIDEO_RENDER'); assert.equal(output?.lifecycle, 'READY'); const probe = await probeMedia(storage.objectPath(output!.storageKey), ffprobePath); assert.equal(probe.width, 1080); assert.equal(probe.height, 1920); assert.equal(probe.audio, true); assert.ok(probe.durationMs > 0);
  } finally { await app?.close(); await db.end(); await temporary.close(); await rm(root, { recursive: true, force: true }); }
});
