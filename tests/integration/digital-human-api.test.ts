import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApi } from '../../apps/api/src/app.js';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { DigitalHumanService, SignedProviderMediaStaging } from '../../packages/modules/digital-human/src/index.js';

const adminUrl = process.env.CONTENTOS_TEST_ADMIN_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test';

async function temporaryDatabase(): Promise<{ url: string; close: () => Promise<void> }> {
  const schema = `contentos_dh_api_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const admin = new pg.Pool({ connectionString: adminUrl });
  await admin.query(`create schema "${schema}"`);
  const url = new URL(adminUrl); url.searchParams.set('options', `-c search_path=${schema}`);
  return { url: url.toString(), close: async () => { await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end(); } };
}

test('Avatar output enters the existing EditManifest and VIDEO_RENDER path idempotently', async () => {
  const temporary = await temporaryDatabase(); const db = await createDatabase(temporary.url); const storageRoot = await mkdtemp(join(tmpdir(), 'contentos-digital-human-api-')); const storage = new LocalStorageProvider(storageRoot); const previousStagingSecret = process.env.CONTENTOS_MEDIA_STAGING_SECRET;
  try {
    await migrateUp(db);
    const project = await new ProjectService(db).create('Digital Human API integration'); const jobs = new JobService(db);
    const speechAssetId = `asset-dh-speech-${randomUUID()}`; const avatarAssetId = `asset-dh-avatar-${randomUUID()}`; const clipAssetId = `asset-dh-clip-${randomUUID()}`;
    for (const [id, kind, storageKey, durationMs] of [[speechAssetId, 'AUDIO', 'objects/speech.wav', 2_000], [avatarAssetId, 'VIDEO', 'objects/avatar.mp4', 2_000], [clipAssetId, 'VIDEO', 'objects/clip.mp4', 2_000] as const]) {
      await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1,$2,$3,$4,$5,$6,$7,$8)', [id, project.id, kind, `sha256:${id}`, 10, storageKey, 'READY', { durationMs, width: 1080, height: 1920, format: kind === 'VIDEO' ? 'mp4' : 'wav' }]);
      await db.query('insert into project_assets (project_id, asset_id, role) values ($1,$2,$3)', [project.id, id, kind === 'AUDIO' ? 'OUTPUT' : 'SOURCE']);
    }
    await db.query('insert into project_assets (project_id, asset_id, role) values ($1,$2,$3)', [project.id, avatarAssetId, 'OUTPUT']);
    const voiceId = `voice-profile-${randomUUID()}`; const speechJob = await jobs.create({ id: `job-speech-${randomUUID()}`, projectId: project.id, type: 'SPEECH_GENERATE', payload: {}, idempotencyKey: `dh-speech-${randomUUID()}`, maxAttempts: 3 });
    await db.query('insert into voice_profiles (id,project_id,name,provider,language,default_speed,default_emotion,status) values ($1,$2,$3,$4,$5,$6,$7,$8)', [voiceId, project.id, 'Integration Voice', 'indextts25', 'zh', 1, 'natural', 'READY']);
    const speechGenerationId = `speech-generation-${randomUUID()}`; await db.query('insert into speech_generations (id,project_id,voice_profile_id,provider,model,text,text_hash,parameters,status,job_id,output_asset_id,duration_ms,latency_ms,provenance) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', [speechGenerationId, project.id, voiceId, 'indextts25', 'indextts-2.5', '这是集成测试文案。', `hash-${randomUUID()}`, { language: 'zh', speed: 1, emotion: 'natural' }, 'SUCCEEDED', speechJob.id, speechAssetId, 2_000, 100, { provider: 'indextts25' }]);
    const avatarProfileId = `avatar-profile-${randomUUID()}`; const avatarClipId = `avatar-clip-${randomUUID()}`; await db.query('insert into avatar_profiles (id,project_id,name,owner_name,status) values ($1,$2,$3,$4,$5)', [avatarProfileId, project.id, 'Integration Avatar', 'test', 'READY']); await db.query('insert into avatar_clips (id,project_id,avatar_profile_id,asset_id,name,duration_ms,status) values ($1,$2,$3,$4,$5,$6,$7)', [avatarClipId, project.id, avatarProfileId, clipAssetId, 'Integration Clip', 2_000, 'READY']);
    const avatarGenerationId = `avatar-generation-${randomUUID()}`; const avatarJob = await jobs.create({ id: `job-avatar-${randomUUID()}`, projectId: project.id, type: 'AVATAR_LIPSYNC_GENERATE', payload: {}, idempotencyKey: `dh-avatar-${randomUUID()}`, maxAttempts: 3 }); await db.query('insert into avatar_generations (id,project_id,avatar_profile_id,avatar_clip_id,speech_asset_id,provider,status,job_id,output_asset_id,duration_ms,request_hash,provenance) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [avatarGenerationId, project.id, avatarProfileId, avatarClipId, speechAssetId, 'hzagent', 'SUCCEEDED', avatarJob.id, avatarAssetId, 2_000, `request-${randomUUID()}`, { provider: 'hzagent' }]);
    await mkdir(join(storageRoot, 'objects'), { recursive: true }); await writeFile(join(storageRoot, 'objects/speech.wav'), Buffer.alloc(10, 97));
    process.env.CONTENTOS_MEDIA_STAGING_SECRET = 'integration-staging-secret';
    const cancelledRemoteTasks: string[] = []; const app = await buildApi({ db, storage, digitalHumanProviders: { speech: {}, avatar: { cancelTask: async (externalTaskId: string) => { cancelledRemoteTasks.push(externalTaskId); } }, staging: {}, mediaStagingConfigured: true } as never }); await app.ready();
    const signedStaging = new SignedProviderMediaStaging({ baseUrl: 'https://contentos.test', secret: 'integration-staging-secret' }); const staged = await signedStaging.stageAsset(speechAssetId, { ttlSeconds: 60 }); const stagedUrl = new URL(staged.publicUrl); const stagedResponse = await app.inject({ method: 'GET', url: `${stagedUrl.pathname}${stagedUrl.search}` }); assert.equal(stagedResponse.statusCode, 200, stagedResponse.body); assert.equal(stagedResponse.body.length, 10); assert.match(stagedResponse.headers['content-type'] || '', /^audio\/wav/);
    const subtitleResponse = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/digital-human/speech-generations/${speechGenerationId}/subtitles?format=srt` }); assert.equal(subtitleResponse.statusCode, 200, subtitleResponse.body); assert.match(subtitleResponse.body, /这是集成测试文案。/); const subtitleAssetId = subtitleResponse.headers['x-contentos-asset-id']; assert.ok(subtitleAssetId); const subtitle = (await db.query<{ kind: string; format: string }>('select kind, metadata->>\'format\' as format from assets where id = $1', [subtitleAssetId])).rows[0]; assert.deepEqual(subtitle, { kind: 'TEXT', format: 'srt' }); const subtitleContent = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/assets/${subtitleAssetId}/content` }); assert.equal(subtitleContent.statusCode, 200); assert.match(subtitleContent.headers['content-type'] || '', /^application\/x-subrip/); assert.match(subtitleContent.body, /这是集成测试文案。/);
    const first = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/digital-human/avatar-generations/${avatarGenerationId}/edit-manifest`, payload: {} }); assert.equal(first.statusCode, 201, first.body); const firstBody = first.json() as { manifestId: string; jobId: string; deduplicated: boolean }; assert.equal(firstBody.deduplicated, false);
    const manifest = (await db.query<{ manifest: Record<string, unknown> }>('select manifest from edit_manifests where id=$1', [firstBody.manifestId])).rows[0]?.manifest; assert.equal(manifest?.projectId, project.id); assert.equal((manifest?.timeline as Array<{ assetId: string }>)[0]?.assetId, avatarAssetId); assert.equal((manifest?.audio as { voiceAssetId?: string }).voiceAssetId, speechAssetId); assert.equal((manifest?.metadata as { digitalHumanGenerationId?: string }).digitalHumanGenerationId, avatarGenerationId);
    const second = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/digital-human/avatar-generations/${avatarGenerationId}/edit-manifest`, payload: {} }); assert.equal(second.statusCode, 200, second.body); const secondBody = second.json() as { manifestId: string; jobId: string; deduplicated: boolean }; assert.deepEqual(secondBody, { manifestId: firstBody.manifestId, jobId: firstBody.jobId, deduplicated: true, editUrl: `/projects/${project.id}/video` });
    const concurrentGenerationId = `avatar-generation-${randomUUID()}`; const concurrentJob = await jobs.create({ id: `job-avatar-${randomUUID()}`, projectId: project.id, type: 'AVATAR_LIPSYNC_GENERATE', payload: {}, idempotencyKey: `dh-avatar-${randomUUID()}`, maxAttempts: 3 }); await db.query('insert into avatar_generations (id,project_id,avatar_profile_id,avatar_clip_id,speech_asset_id,provider,status,job_id,output_asset_id,duration_ms,request_hash,provenance) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [concurrentGenerationId, project.id, avatarProfileId, avatarClipId, speechAssetId, 'hzagent', 'SUCCEEDED', concurrentJob.id, avatarAssetId, 2_000, `request-${randomUUID()}`, { provider: 'hzagent' }]);
    const concurrentHandoffs = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/digital-human/avatar-generations/${concurrentGenerationId}/edit-manifest`, payload: {} }))); const concurrentBodies = concurrentHandoffs.map((response) => response.json() as { manifestId: string; jobId: string; deduplicated: boolean }); assert.deepEqual(concurrentHandoffs.map((response) => response.statusCode).sort(), [200, 201]); assert.equal(new Set(concurrentBodies.map((body) => body.manifestId)).size, 1); assert.equal(new Set(concurrentBodies.map((body) => body.jobId)).size, 1); assert.deepEqual(concurrentBodies.map((body) => body.deduplicated).sort(), [false, true]); const concurrentManifestCount = await db.query<{ count: string }>("select count(*)::text as count from edit_manifests where project_id = $1 and manifest->'metadata'->>'digitalHumanGenerationId' = $2", [project.id, concurrentGenerationId]); assert.equal(concurrentManifestCount.rows[0]?.count, '1');

    const digitalHuman = new DigitalHumanService(db, jobs);
    const raceVoiceId = `voice-profile-${randomUUID()}`;
    await db.query('insert into voice_profiles (id,project_id,name,provider,reference_asset_id,language,default_speed,default_emotion,status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [raceVoiceId, project.id, 'Concurrent Voice', 'indextts25', speechAssetId, 'zh', 1, 'natural', 'READY']);
    const speechResults = await Promise.all([1, 2].map((index) => digitalHuman.createSpeechGeneration({ projectId: project.id, voiceProfileId: raceVoiceId, text: '并发幂等测试。', correlationId: `race-${index}` })));
    assert.equal(new Set(speechResults.map((result) => result.generation.id)).size, 1);
    assert.equal(new Set(speechResults.map((result) => result.job.id)).size, 1);
    assert.equal(speechResults.filter((result) => result.created).length, 1);
    const speechCount = await db.query<{ count: string }>('select count(*)::text as count from speech_generations where project_id = $1 and voice_profile_id = $2', [project.id, raceVoiceId]); assert.equal(speechCount.rows[0]?.count, '1');
    const speechJobCount = await db.query<{ count: string }>('select count(*)::text as count from jobs where project_id = $1 and idempotency_key like $2', [project.id, 'digital-human:speech:%']); assert.equal(speechJobCount.rows[0]?.count, '1');

    const avatarResults = await Promise.all([1, 2].map((index) => digitalHuman.createAvatarGeneration({ projectId: project.id, avatarProfileId, avatarClipId, speechAssetId, correlationId: `avatar-race-${index}` })));
    assert.equal(new Set(avatarResults.map((result) => result.generation.id)).size, 1);
    assert.equal(new Set(avatarResults.map((result) => result.job.id)).size, 1);
    assert.equal(avatarResults.filter((result) => result.created).length, 1);
    const clipUsage = await db.query<{ usage_count: number; last_used_at: string | null }>('select usage_count, last_used_at from avatar_clips where id = $1', [avatarClipId]);
    assert.equal(Number(clipUsage.rows[0]?.usage_count), 1); assert.ok(clipUsage.rows[0]?.last_used_at);
    const secondAvatar = await digitalHuman.createAvatarProfile({ projectId: project.id, name: 'Second Avatar Profile', status: 'READY' });
    const secondClip = await digitalHuman.createAvatarClip({ projectId: project.id, avatarProfileId: secondAvatar.id, assetId: clipAssetId, name: 'Same Source, Different Profile' });
    const distinctProfileGeneration = await digitalHuman.createAvatarGeneration({ projectId: project.id, avatarProfileId: secondAvatar.id, avatarClipId: secondClip.id, speechAssetId, correlationId: 'distinct-profile' });
    assert.equal(distinctProfileGeneration.created, true); assert.notEqual(distinctProfileGeneration.generation.id, avatarResults[0]!.generation.id);
    const avatarJobCount = await db.query<{ count: string }>('select count(*)::text as count from jobs where project_id = $1 and type = $2', [project.id, 'AVATAR_LIPSYNC_GENERATE']); assert.equal(avatarJobCount.rows[0]?.count, '4');
    await db.query("update speech_generations set status = 'FAILED', error = '{\"code\":\"TEST_FAILURE\"}'::jsonb where id = $1", [speechResults[0]!.generation.id]);
    await db.query("update jobs set state = 'FAILED', error = '{\"code\":\"TEST_FAILURE\"}'::jsonb where id = $1", [speechResults[0]!.job.id]);
    const speechRetry = await digitalHuman.createSpeechGeneration({ projectId: project.id, voiceProfileId: raceVoiceId, text: '并发幂等测试。', correlationId: 'retry-speech' });
    assert.equal(speechRetry.created, false); assert.equal(speechRetry.generation.id, speechResults[0]!.generation.id); assert.equal(speechRetry.generation.status, 'PENDING'); assert.equal(speechRetry.job.state, 'QUEUED');
    await db.query("update avatar_generations set status = 'FAILED', error = '{\"code\":\"TEST_FAILURE\"}'::jsonb where id = $1", [avatarResults[0]!.generation.id]);
    await db.query("update jobs set state = 'FAILED', error = '{\"code\":\"TEST_FAILURE\"}'::jsonb where id = $1", [avatarResults[0]!.job.id]);
    const avatarRetry = await digitalHuman.createAvatarGeneration({ projectId: project.id, avatarProfileId, avatarClipId, speechAssetId, correlationId: 'retry-avatar' });
    assert.equal(avatarRetry.created, false); assert.equal(avatarRetry.generation.id, avatarResults[0]!.generation.id); assert.equal(avatarRetry.generation.status, 'PENDING'); assert.equal(avatarRetry.job.state, 'QUEUED');
    const cancelSpeech = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/digital-human/speech-generations/${speechResults[0]!.generation.id}/cancel` }); assert.equal(cancelSpeech.statusCode, 200, cancelSpeech.body); assert.equal(cancelSpeech.json<{ status: string; cancelRequested: boolean }>().status, 'CANCELLED'); assert.equal(cancelSpeech.json<{ status: string; cancelRequested: boolean }>().cancelRequested, true);
    await db.query('update avatar_generations set external_task_id = $2 where id = $1', [avatarResults[0]!.generation.id, 'remote-api-cancel']);
    const cancelAvatar = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/digital-human/avatar-generations/${avatarResults[0]!.generation.id}/cancel` }); assert.equal(cancelAvatar.statusCode, 200, cancelAvatar.body); assert.equal(cancelAvatar.json<{ status: string; cancelRequested: boolean }>().status, 'CANCELLED'); assert.equal(cancelAvatar.json<{ status: string; cancelRequested: boolean }>().cancelRequested, true);
    assert.deepEqual(cancelledRemoteTasks, ['remote-api-cancel']);
    const cancelledJobs = await db.query<{ state: string }>('select state from jobs where id = any($1::text[]) order by id', [[speechResults[0]!.job.id, avatarResults[0]!.job.id]]); assert.deepEqual(cancelledJobs.rows.map((row) => row.state).sort(), ['CANCELLED', 'CANCELLED']);
    await app.close();
  } finally { if (previousStagingSecret === undefined) delete process.env.CONTENTOS_MEDIA_STAGING_SECRET; else process.env.CONTENTOS_MEDIA_STAGING_SECRET = previousStagingSecret; await db.end(); await rm(storageRoot, { recursive: true, force: true }); await temporary.close(); }
});
