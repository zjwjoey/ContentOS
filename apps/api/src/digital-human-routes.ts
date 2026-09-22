import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DigitalHumanDurationError, DigitalHumanService, SyntheticTimingProvider, normalizeAvatarTiming, speechCapabilityError, subtitleTimelineToAss, subtitleTimelineToManifestCues, subtitleTimelineToSrt, verifyProviderMediaToken } from '../../../packages/modules/digital-human/src/index.js';
import type { RuntimeDigitalHumanProviders } from '../../../packages/modules/digital-human/src/index.js';
import { DEFAULT_PRESENTATION_SETTINGS_V1, type EditManifestV0 } from '../../../packages/contracts/src/index.js';
import { AssetService, type AssetCatalogService } from '../../../packages/modules/asset/src/index.js';
import type { VideoAdjustmentService, VideoService } from '../../../packages/modules/video/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import type { ProjectService } from '../../../packages/modules/project/src/index.js';
import type { JobService } from '../../../packages/modules/job/src/index.js';

const voiceInput = z.object({ name: z.string().trim().min(1).max(200), provider: z.string().trim().min(1).max(100).optional(), referenceAssetId: z.string().trim().min(1).max(200).optional(), providerVoiceId: z.string().trim().min(1).max(200).optional(), language: z.string().trim().min(1).max(20).default('zh'), defaultSpeed: z.number().min(.5).max(2).default(1), defaultEmotion: z.string().trim().min(1).max(100).default('natural') }).strict();
const voicePatch = z.object({ name: z.string().trim().min(1).max(200).optional(), referenceAssetId: z.string().trim().min(1).max(200).nullable().optional(), providerVoiceId: z.string().trim().min(1).max(200).nullable().optional(), language: z.string().trim().min(1).max(20).optional(), defaultSpeed: z.number().min(.5).max(2).optional(), defaultEmotion: z.string().trim().min(1).max(100).optional(), status: z.enum(['DRAFT', 'READY', 'DISABLED']).optional() }).strict();
const avatarInput = z.object({ name: z.string().trim().min(1).max(200), ownerName: z.string().trim().max(200).default('') }).strict();
const avatarPatch = z.object({ name: z.string().trim().min(1).max(200).optional(), ownerName: z.string().trim().max(200).optional(), status: z.enum(['DRAFT', 'READY', 'DISABLED']).optional() }).strict();
const clipInput = z.object({ avatarProfileId: z.string().trim().min(1).max(200), assetId: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(200), durationMs: z.number().int().positive().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), fps: z.number().positive().optional(), sceneType: z.string().trim().max(100).optional(), gestureLevel: z.string().trim().max(100).optional(), tags: z.array(z.string().trim().min(1).max(100)).max(64).optional() }).strict();
const clipPatch = z.object({ assetId: z.string().trim().min(1).max(200).optional(), name: z.string().trim().min(1).max(200).optional(), durationMs: z.number().int().positive().nullable().optional(), width: z.number().int().positive().nullable().optional(), height: z.number().int().positive().nullable().optional(), fps: z.number().positive().nullable().optional(), sceneType: z.string().trim().max(100).nullable().optional(), gestureLevel: z.string().trim().max(100).nullable().optional(), tags: z.array(z.string().trim().min(1).max(100)).max(64).optional(), status: z.enum(['DRAFT', 'READY', 'DISABLED']).optional() }).strict();
const avatarPreflightInput = z.object({ avatarProfileId: z.string().trim().min(1).max(200), avatarClipId: z.string().trim().min(1).max(200), speechAssetId: z.string().trim().min(1).max(200), sourceInMs: z.number().int().nonnegative().default(0) }).strict();
const speechInput = z.object({ voiceProfileId: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(100_000), provider: z.string().trim().min(1).max(100).optional(), model: z.string().trim().min(1).max(100).optional(), language: z.string().trim().min(1).max(20).optional(), speed: z.number().min(.5).max(2).optional(), emotion: z.string().trim().min(1).max(100).optional(), correlationId: z.string().trim().min(1).max(200).optional() }).strict();
const avatarGenerationInput = z.object({ avatarProfileId: z.string().trim().min(1).max(200), avatarClipId: z.string().trim().min(1).max(200), speechAssetId: z.string().trim().min(1).max(200), sourceInMs: z.number().int().nonnegative().default(0), provider: z.string().trim().min(1).max(100).optional(), model: z.string().trim().min(1).max(100).optional(), parameters: z.record(z.string(), z.unknown()).optional(), correlationId: z.string().trim().min(1).max(200).optional() }).strict();
const editManifestInput = z.object({ seed: z.number().int().default(1), includeSubtitles: z.boolean().default(true) }).strict();

export interface DigitalHumanRouteDependencies { digitalHuman: DigitalHumanService; projects: ProjectService; jobs: JobService; providers?: RuntimeDigitalHumanProviders; quickEdit?: VideoAdjustmentService; video?: VideoService; assets?: AssetCatalogService; assetService?: AssetService; storage?: LocalStorageProvider; mediaStagingSecret?: string | undefined; }
function fail(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, status: number, code: string, message: string): unknown { return reply.code(status).send({ error: { code, message, details: [] } }); }
function invalid(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, details: unknown): unknown { return reply.code(422).send({ error: { code: 'DIGITAL_HUMAN_VALIDATION_ERROR', message: 'Invalid digital human input', details } }); }
function projectId(request: { params: unknown }): string { return (request.params as { projectId: string }).projectId; }
function configuredProviderId(deps: DigitalHumanRouteDependencies, kind: 'speech' | 'avatar'): string | undefined { return deps.providers?.[kind].providerId; }
function providerMismatch(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, kind: 'SPEECH' | 'AVATAR', expected: string, received: string): unknown { return fail(reply, 409, `${kind}_PROVIDER_ID_MISMATCH`, `${kind === 'SPEECH' ? 'Speech' : 'Avatar'} provider must be ${expected}; received ${received}`); }

type PreflightCheck = { code: string; status: 'READY' | 'BLOCKED'; message: string; details?: Record<string, number> };
type AvatarPreflightResult = { status: 'READY' | 'BLOCKED'; checks: PreflightCheck[]; timing?: ReturnType<typeof normalizeAvatarTiming> };

async function runAvatarPreflight(projectId: string, input: { avatarProfileId: string; avatarClipId: string; speechAssetId: string; sourceInMs?: number }, deps: DigitalHumanRouteDependencies): Promise<AvatarPreflightResult> {
  const checks: PreflightCheck[] = [];
  const block = (code: string, message: string) => checks.push({ code, status: 'BLOCKED', message });
  const ready = (code: string, message: string) => checks.push({ code, status: 'READY', message });
  const profile = await deps.digitalHuman.getAvatarProfile(projectId, input.avatarProfileId);
  if (!profile || profile.status === 'DISABLED') block('AVATAR_PROFILE_NOT_READY', 'Avatar Profile is missing or disabled');
  const clip = await deps.digitalHuman.getAvatarClip(projectId, input.avatarClipId);
  if (!clip || clip.avatarProfileId !== input.avatarProfileId || clip.status === 'DISABLED') block('AVATAR_CLIP_NOT_READY', 'Avatar Clip is missing, mismatched, or disabled');
  const video = clip && deps.assets ? await deps.assets.getReadySourceAsset(projectId, clip.assetId, 'VIDEO') : null;
  if (!video) block('AVATAR_CLIP_ASSET_NOT_READY', 'Avatar source video must be READY');
  else if (!(Number(video.metadata.durationMs) > 0)) block('AVATAR_CLIP_DURATION_INVALID', 'Avatar source video duration must be positive');
  else ready('AVATAR_CLIP_ASSET_READY', 'Avatar source video is READY');
  const speech = deps.assets ? await deps.assets.getReadySourceAsset(projectId, input.speechAssetId, 'AUDIO') : null;
  if (!speech) block('SPEECH_ASSET_NOT_READY', 'Speech audio Asset must be READY');
  else if (!(Number(speech.metadata.durationMs) > 0)) block('SPEECH_ASSET_DURATION_INVALID', 'Speech audio duration must be positive');
  else ready('SPEECH_ASSET_READY', 'Speech audio Asset is READY');
  let timing: ReturnType<typeof normalizeAvatarTiming> | undefined;
  if (video && speech) { try { timing = normalizeAvatarTiming(video, speech, input.sourceInMs ?? 0); ready('DURATION_POLICY_READY', 'Audio duration is the output duration and source range is valid'); } catch (error) { if (error instanceof DigitalHumanDurationError) checks.push({ code: error.code, status: 'BLOCKED', message: error.code === 'SOURCE_VIDEO_TOO_SHORT' ? 'Source video is shorter than the requested audio duration' : error.message, details: error.details }); } }
  if (!deps.providers) {
    block('DIGITAL_HUMAN_PROVIDERS_UNCONFIGURED', 'Digital Human providers are not configured');
  } else {
    try {
       const capabilities = await deps.providers.avatar.getCapabilities();
       if (capabilities.providerId !== deps.providers.avatar.providerId) block('AVATAR_PROVIDER_IDENTITY_MISMATCH', 'Avatar provider capability identity does not match the configured runtime provider');
       else {
         if (!capabilities.videoToVideo && !capabilities.imageToVideo) block('AVATAR_PROVIDER_UNAVAILABLE', 'Avatar provider does not support video generation');
         else if (!capabilities.videoToVideo) block('AVATAR_VIDEO_TO_VIDEO_UNSUPPORTED', 'Avatar provider does not support video-to-video generation for this video clip');
         else ready('AVATAR_PROVIDER_HEALTHY', 'Avatar provider is reachable for video-to-video generation');
         if (capabilities.requiresPublicUrl && !deps.providers.mediaStagingConfigured) block('MEDIA_STAGING_NOT_CONFIGURED', 'Public media staging is required for this avatar provider');
         else if (capabilities.requiresPublicUrl) ready('MEDIA_STAGING_READY', 'Public media staging is configured');
         const videoFormat = String(video?.metadata.format || '').toLowerCase().replace(/^\./, '').split('/').pop() || '';
         const audioFormat = String(speech?.metadata.format || '').toLowerCase().replace(/^\./, '').split('/').pop() || '';
         if (videoFormat && capabilities.supportedFormats.length > 0 && !capabilities.supportedFormats.some((format) => format.toLowerCase().replace(/^\./, '') === videoFormat)) block('AVATAR_VIDEO_FORMAT_UNSUPPORTED', `Avatar provider does not support ${videoFormat} video input`);
         if (audioFormat && capabilities.supportedAudioFormats?.length && !capabilities.supportedAudioFormats.some((format) => format.toLowerCase().replace(/^\./, '') === audioFormat)) block('AVATAR_AUDIO_FORMAT_UNSUPPORTED', `Avatar provider does not support ${audioFormat} audio input`);
         if (video && capabilities.maxDurationSeconds !== undefined && Number(video.metadata.durationMs) > capabilities.maxDurationSeconds * 1_000) block('AVATAR_DURATION_EXCEEDS_PROVIDER_LIMIT', 'Avatar source video exceeds provider duration limit');
       }
    } catch { block('AVATAR_PROVIDER_UNAVAILABLE', 'Avatar provider capability check failed'); }
  }
  return { status: checks.some((check) => check.status === 'BLOCKED') ? 'BLOCKED' : 'READY', checks, ...(timing ? { timing } : {}) };
}

function preflightFailure(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, result: AvatarPreflightResult): unknown {
  const first = result.checks.find((check) => check.status === 'BLOCKED');
  return reply.code(409).send({ error: { code: first?.code || 'DIGITAL_HUMAN_PREFLIGHT_BLOCKED', message: first?.message || 'Digital Human preflight blocked', details: result.checks }, preflight: result });
}

export function registerDigitalHumanRoutes(app: FastifyInstance, deps: DigitalHumanRouteDependencies): void {
  app.get('/api/v1/provider-media', async (request, reply) => {
    const token = (request.query as { token?: string }).token || ''; const secret = deps.mediaStagingSecret?.trim();
    if (!secret || !deps.assets || !deps.storage) return reply.code(404).send({ error: { code: 'PROVIDER_MEDIA_NOT_FOUND', message: 'Provider media is not available', details: [] } });
    const verified = verifyProviderMediaToken(token, secret); if (!verified) return reply.code(404).send({ error: { code: 'PROVIDER_MEDIA_NOT_FOUND', message: 'Provider media is not available', details: [] } });
    const asset = await deps.assets.getReadyAssetForProviderStaging(verified.projectId, verified.assetId); if (!asset || !await deps.storage.exists(asset.storageKey)) return reply.code(404).send({ error: { code: 'PROVIDER_MEDIA_NOT_FOUND', message: 'Provider media is not available', details: [] } });
    const contentType = asset.kind === 'VIDEO' ? 'video/mp4' : asset.metadata.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    return reply.header('cache-control', 'private, max-age=0, no-store').header('content-length', asset.byteSize).type(contentType).send(createReadStream(deps.storage.objectPath(asset.storageKey)));
  });
  app.get('/api/v1/projects/:projectId/digital-human/capabilities', async (_request, reply) => {
    if (!deps.providers) return { speech: { status: 'UNCONFIGURED' }, avatar: { status: 'UNCONFIGURED' }, mediaStaging: { status: 'UNCONFIGURED' } };
    const [speech, avatar] = await Promise.allSettled([deps.providers.speech.getCapabilities(), deps.providers.avatar.getCapabilities()]);
    return {
      speech: speech.status === 'fulfilled' ? { status: 'READY', ...speech.value } : { status: 'UNAVAILABLE', providerId: deps.providers.speech.providerId },
      avatar: avatar.status === 'fulfilled' ? { status: 'READY', ...avatar.value } : { status: 'UNAVAILABLE', providerId: deps.providers.avatar.providerId },
      mediaStaging: { status: deps.providers.mediaStagingConfigured ? 'READY' : 'UNAVAILABLE' },
    };
  });
  app.post('/api/v1/projects/:projectId/digital-human/avatar-generations/preflight', async (request, reply) => { const parsed = avatarPreflightInput.safeParse(request.body); if (!parsed.success) return invalid(reply, parsed.error.issues); const result = await runAvatarPreflight(projectId(request), parsed.data, deps); return result; });
  app.post('/api/v1/projects/:projectId/digital-human/avatar-generations/:generationId/edit-manifest', async (request, reply) => {
    const parsed = editManifestInput.safeParse(request.body || {}); if (!parsed.success) return invalid(reply, parsed.error.issues);
    if (!deps.quickEdit || !deps.video || !deps.assets || !deps.storage) return fail(reply, 503, 'VIDEO_EDIT_INTEGRATION_UNAVAILABLE', 'Video editing integration is not configured');
    const params = request.params as { projectId: string; generationId: string }; const generation = await deps.digitalHuman.getAvatarGeneration(params.projectId, params.generationId);
    if (!generation) return fail(reply, 404, 'AVATAR_GENERATION_NOT_FOUND', 'Avatar Generation not found');
    if (generation.status !== 'SUCCEEDED' || !generation.outputAssetId) return fail(reply, 409, 'AVATAR_GENERATION_NOT_READY', 'Avatar Generation has no output video yet');
    const existing = (await deps.quickEdit.listManifests(params.projectId)).find((item) => item.manifest.metadata?.digitalHumanGenerationId === generation.id);
    if (existing) { const job = await deps.video.createManifestRenderJob(params.projectId, existing.id); return { manifestId: existing.id, jobId: job.id, deduplicated: true, editUrl: `/projects/${params.projectId}/video` }; }
    const videoAsset = await deps.assets.getReadyAssetContent(params.projectId, generation.outputAssetId); const speechAsset = await deps.assets.getReadyAssetContent(params.projectId, generation.speechAssetId);
    if (!videoAsset || videoAsset.kind !== 'VIDEO') return fail(reply, 409, 'AVATAR_OUTPUT_ASSET_NOT_READY', 'Avatar output video asset is not ready');
    if (!speechAsset || speechAsset.kind !== 'AUDIO') return fail(reply, 409, 'SPEECH_OUTPUT_ASSET_NOT_READY', 'Speech output audio asset is not ready');
    const speech = (await deps.digitalHuman.listSpeechGenerations(params.projectId)).find((item) => item.outputAssetId === generation.speechAssetId);
    if (!speech) return fail(reply, 409, 'SPEECH_GENERATION_NOT_FOUND', 'Speech generation for avatar output was not found');
    const durationMs = Number(videoAsset.metadata.durationMs || generation.durationMs || speech.durationMs || 0); if (!Number.isFinite(durationMs) || durationMs <= 0) return fail(reply, 409, 'AVATAR_OUTPUT_DURATION_UNAVAILABLE', 'Avatar output video has no valid duration');
    const timeline = await new SyntheticTimingProvider().align({ text: speech.text, durationMs, language: String(speech.parameters.language || 'zh') });
    const presentation = structuredClone(DEFAULT_PRESENTATION_SETTINGS_V1); presentation.subtitleStyle = { ...presentation.subtitleStyle, ...(process.env.FFMPEG_FONT_FILE ? { fontFile: process.env.FFMPEG_FONT_FILE } : {}) };
    const manifest: EditManifestV0 = { schemaVersion: 'EDIT_MANIFEST_V0', projectId: params.projectId, seed: parsed.data.seed, canvas: presentation.canvas, timeline: [{ assetId: videoAsset.id, sourcePath: deps.storage.objectPath(videoAsset.storageKey), sourceInMs: 0, durationMs, transition: 'cut', role: 'CONTENT', reviewStatus: 'GOOD' }], audio: { voiceAssetId: speechAsset.id, voicePath: deps.storage.objectPath(speechAsset.storageKey), volume: 1 }, ...(parsed.data.includeSubtitles ? { subtitles: subtitleTimelineToManifestCues(timeline) } : {}), subtitleStyle: presentation.subtitleStyle, presentationSettings: presentation, metadata: { editMode: 'SCRIPT', digitalHumanGenerationId: generation.id, rawScript: speech.text, cleanedScript: speech.text, confirmedSegments: [speech.text] }, output: presentation.output };
    const record = await deps.quickEdit.createPlannedManifest({ projectId: params.projectId, manifest, createdBy: 'digital-human', idempotencyKey: `digital-human:manifest:${generation.id}` }); const job = await deps.video.createManifestRenderJob(params.projectId, record.id);
    return reply.code(record.created === false ? 200 : 201).send({ manifestId: record.id, jobId: job.id, deduplicated: record.created === false, editUrl: `/projects/${params.projectId}/video` });
  });
  app.get('/api/v1/projects/:projectId/digital-human/voices', async (request, reply) => { const id = projectId(request); return { items: await deps.digitalHuman.listVoiceProfiles(id) }; });
  app.post('/api/v1/projects/:projectId/digital-human/voices', async (request, reply) => { const parsed = voiceInput.safeParse(request.body); if (!parsed.success) return invalid(reply, parsed.error.issues); const id = projectId(request); if (!(await deps.projects.get(id))) return fail(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found'); const runtimeProvider = configuredProviderId(deps, 'speech'); if (runtimeProvider && parsed.data.provider && parsed.data.provider !== runtimeProvider) return providerMismatch(reply, 'SPEECH', runtimeProvider, parsed.data.provider); try { return reply.code(201).send(await deps.digitalHuman.createVoiceProfile({ projectId: id, ...parsed.data, provider: parsed.data.provider || runtimeProvider || 'indextts25' })); } catch (error) { return fail(reply, 409, 'VOICE_PROFILE_CONFLICT', error instanceof Error ? error.message : 'Unable to create Voice Profile'); } });
  app.patch('/api/v1/projects/:projectId/digital-human/voices/:voiceId', async (request, reply) => { const parsed = voicePatch.safeParse(request.body); if (!parsed.success) return invalid(reply, parsed.error.issues); const params = request.params as { projectId: string; voiceId: string }; try { const voice = await deps.digitalHuman.updateVoiceProfile(params.projectId, params.voiceId, parsed.data); return voice ? voice : fail(reply, 404, 'VOICE_PROFILE_NOT_FOUND', 'Voice Profile not found'); } catch (error) { return fail(reply, 409, 'VOICE_PROFILE_CONFLICT', error instanceof Error ? error.message : 'Unable to update Voice Profile'); } });
  app.delete('/api/v1/projects/:projectId/digital-human/voices/:voiceId', async (request, reply) => { const params = request.params as { projectId: string; voiceId: string }; const voice = await deps.digitalHuman.disableVoiceProfile(params.projectId, params.voiceId); return voice ? voice : fail(reply, 404, 'VOICE_PROFILE_NOT_FOUND', 'Voice Profile not found'); });
  app.get('/api/v1/projects/:projectId/digital-human/avatars', async (request) => { const id = projectId(request); const profiles = await deps.digitalHuman.listAvatarProfiles(id); return { items: await Promise.all(profiles.map(async (profile) => ({ ...profile, clips: await deps.digitalHuman.listAvatarClips(id, profile.id) }))) }; });
  app.post('/api/v1/projects/:projectId/digital-human/avatars', async (request, reply) => { const parsed = avatarInput.safeParse(request.body); if (!parsed.success) return invalid(reply, parsed.error.issues); const id = projectId(request); if (!(await deps.projects.get(id))) return fail(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found'); try { return reply.code(201).send(await deps.digitalHuman.createAvatarProfile({ projectId: id, ...parsed.data })); } catch (error) { return fail(reply, 409, 'AVATAR_PROFILE_CONFLICT', error instanceof Error ? error.message : 'Unable to create Avatar Profile'); } });
  app.patch('/api/v1/projects/:projectId/digital-human/avatars/:avatarId', async (request, reply) => { const parsed = avatarPatch.safeParse(request.body); if (!parsed.success) return invalid(reply, parsed.error.issues); const params = request.params as { projectId: string; avatarId: string }; try { const avatar = await deps.digitalHuman.updateAvatarProfile(params.projectId, params.avatarId, parsed.data); return avatar ? avatar : fail(reply, 404, 'AVATAR_PROFILE_NOT_FOUND', 'Avatar Profile not found'); } catch (error) { return fail(reply, 409, 'AVATAR_PROFILE_CONFLICT', error instanceof Error ? error.message : 'Unable to update Avatar Profile'); } });
  app.delete('/api/v1/projects/:projectId/digital-human/avatars/:avatarId', async (request, reply) => { const params = request.params as { projectId: string; avatarId: string }; const avatar = await deps.digitalHuman.disableAvatarProfile(params.projectId, params.avatarId); return avatar ? avatar : fail(reply, 404, 'AVATAR_PROFILE_NOT_FOUND', 'Avatar Profile not found'); });
  app.post('/api/v1/projects/:projectId/digital-human/avatar-clips', async (request, reply) => { const parsed = clipInput.safeParse(request.body); if (!parsed.success) return invalid(reply, parsed.error.issues); try { return reply.code(201).send(await deps.digitalHuman.createAvatarClip({ projectId: projectId(request), ...parsed.data })); } catch (error) { return fail(reply, 409, 'AVATAR_CLIP_CONFLICT', error instanceof Error ? error.message : 'Unable to create Avatar Clip'); } });
  app.patch('/api/v1/projects/:projectId/digital-human/avatar-clips/:clipId', async (request, reply) => { const parsed = clipPatch.safeParse(request.body); if (!parsed.success) return invalid(reply, parsed.error.issues); const params = request.params as { projectId: string; clipId: string }; try { const clip = await deps.digitalHuman.updateAvatarClip(params.projectId, params.clipId, parsed.data); return clip ? clip : fail(reply, 404, 'AVATAR_CLIP_NOT_FOUND', 'Avatar Clip not found'); } catch (error) { return fail(reply, 409, 'AVATAR_CLIP_CONFLICT', error instanceof Error ? error.message : 'Unable to update Avatar Clip'); } });
  app.delete('/api/v1/projects/:projectId/digital-human/avatar-clips/:clipId', async (request, reply) => { const params = request.params as { projectId: string; clipId: string }; const clip = await deps.digitalHuman.disableAvatarClip(params.projectId, params.clipId); return clip ? clip : fail(reply, 404, 'AVATAR_CLIP_NOT_FOUND', 'Avatar Clip not found'); });
  app.post('/api/v1/projects/:projectId/digital-human/speech-generations', async (request, reply) => {
    const parsed = speechInput.safeParse(request.body); if (!parsed.success) return invalid(reply, parsed.error.issues);
    const id = projectId(request);
    const runtimeProvider = configuredProviderId(deps, 'speech');
    if (runtimeProvider && parsed.data.provider && parsed.data.provider !== runtimeProvider) return providerMismatch(reply, 'SPEECH', runtimeProvider, parsed.data.provider);
    if (deps.providers) {
      const profile = await deps.digitalHuman.getVoiceProfile(id, parsed.data.voiceProfileId);
      if (!profile) return fail(reply, 404, 'VOICE_PROFILE_NOT_FOUND', 'Voice Profile not found');
      if (runtimeProvider && profile.provider !== runtimeProvider) return providerMismatch(reply, 'SPEECH', runtimeProvider, profile.provider);
      try {
       const capabilities = await deps.providers.speech.getCapabilities();
       if (runtimeProvider && capabilities.providerId !== runtimeProvider) return fail(reply, 503, 'SPEECH_PROVIDER_IDENTITY_MISMATCH', 'Speech provider capability identity does not match the configured runtime provider');
        const capabilityError = speechCapabilityError(capabilities, { text: parsed.data.text, language: parsed.data.language || profile.language, speed: parsed.data.speed ?? profile.defaultSpeed, emotion: parsed.data.emotion || profile.defaultEmotion, hasReferenceAudio: Boolean(profile.referenceAssetId), hasProviderVoiceId: Boolean(profile.providerVoiceId) });
        if (capabilityError) return fail(reply, 409, capabilityError.code, capabilityError.message);
      } catch (error) { return fail(reply, 503, 'SPEECH_PROVIDER_UNAVAILABLE', error instanceof Error ? error.message : 'Speech provider is unavailable'); }
    }
    try { const result = await deps.digitalHuman.createSpeechGeneration({ projectId: id, ...parsed.data, ...(runtimeProvider ? { provider: runtimeProvider } : {}), correlationId: parsed.data.correlationId || `api-${randomUUID()}` }); return reply.code(result.created ? 202 : 200).send({ ...result.generation, jobId: result.job.id, deduplicated: !result.created }); } catch (error) { return fail(reply, 409, 'SPEECH_GENERATION_CONFLICT', error instanceof Error ? error.message : 'Unable to create Speech Generation'); }
  });
  app.get('/api/v1/projects/:projectId/digital-human/speech-generations', async (request) => ({ items: await deps.digitalHuman.listSpeechGenerations(projectId(request)) }));
  app.get('/api/v1/projects/:projectId/digital-human/speech-generations/:generationId', async (request, reply) => { const params = request.params as { projectId: string; generationId: string }; const generation = await deps.digitalHuman.getSpeechGeneration(params.projectId, params.generationId); return generation || fail(reply, 404, 'SPEECH_GENERATION_NOT_FOUND', 'Speech Generation not found'); });
  app.post('/api/v1/projects/:projectId/digital-human/speech-generations/:generationId/cancel', async (request, reply) => {
    const params = request.params as { projectId: string; generationId: string }; const generation = await deps.digitalHuman.getSpeechGeneration(params.projectId, params.generationId);
    if (!generation) return fail(reply, 404, 'SPEECH_GENERATION_NOT_FOUND', 'Speech Generation not found');
    if (generation.status === 'CANCELLED') return { ...generation, cancelRequested: false };
    if (generation.status === 'SUCCEEDED' || generation.status === 'FAILED') return fail(reply, 409, 'SPEECH_GENERATION_NOT_CANCELLABLE', 'Only active Speech Generations can be cancelled');
    await deps.jobs.requestCancel(generation.jobId); await deps.digitalHuman.cancelSpeech(generation.id);
    return { ...((await deps.digitalHuman.getSpeechGeneration(params.projectId, params.generationId)) || generation), cancelRequested: true };
  });
  app.post('/api/v1/projects/:projectId/digital-human/speech-generations/:generationId/retry', async (request, reply) => {
    const params = request.params as { projectId: string; generationId: string }; const generation = await deps.digitalHuman.getSpeechGeneration(params.projectId, params.generationId);
    if (!generation) return fail(reply, 404, 'SPEECH_GENERATION_NOT_FOUND', 'Speech Generation not found');
    if (generation.status !== 'FAILED' && generation.status !== 'CANCELLED') return fail(reply, 409, 'SPEECH_GENERATION_NOT_RETRYABLE', 'Only failed or cancelled Speech Generations can be retried');
    const runtimeProvider = configuredProviderId(deps, 'speech');
    if (runtimeProvider && generation.provider !== runtimeProvider) return providerMismatch(reply, 'SPEECH', runtimeProvider, generation.provider);
    const job = await deps.jobs.get(generation.jobId);
    if (!job) return fail(reply, 409, 'SPEECH_GENERATION_JOB_NOT_FOUND', 'Speech Generation Job not found');
    if (job.state !== 'FAILED' && job.state !== 'CANCELLED') return fail(reply, 409, 'SPEECH_GENERATION_JOB_NOT_TERMINAL', 'Speech Generation Job is still active; retry after cancellation or failure completes');
    if (deps.providers) {
      const profile = await deps.digitalHuman.getVoiceProfile(params.projectId, generation.voiceProfileId);
      if (!profile) return fail(reply, 404, 'VOICE_PROFILE_NOT_FOUND', 'Voice Profile not found');
       try { const capabilities = await deps.providers.speech.getCapabilities(); if (runtimeProvider && capabilities.providerId !== runtimeProvider) return fail(reply, 503, 'SPEECH_PROVIDER_IDENTITY_MISMATCH', 'Speech provider capability identity does not match the configured runtime provider'); const capabilityError = speechCapabilityError(capabilities, { text: generation.text, language: typeof generation.parameters.language === 'string' ? generation.parameters.language : profile.language, speed: typeof generation.parameters.speed === 'number' ? generation.parameters.speed : profile.defaultSpeed, emotion: typeof generation.parameters.emotion === 'string' ? generation.parameters.emotion : profile.defaultEmotion, hasReferenceAudio: Boolean(profile.referenceAssetId), hasProviderVoiceId: Boolean(profile.providerVoiceId) }); if (capabilityError) return fail(reply, 409, capabilityError.code, capabilityError.message); }
      catch (error) { return fail(reply, 503, 'SPEECH_PROVIDER_UNAVAILABLE', error instanceof Error ? error.message : 'Speech provider is unavailable'); }
    }
    try {
      const result = await deps.digitalHuman.createSpeechGeneration({ projectId: params.projectId, voiceProfileId: generation.voiceProfileId, text: generation.text, provider: runtimeProvider || generation.provider, model: generation.model, language: typeof generation.parameters.language === 'string' ? generation.parameters.language : undefined, speed: typeof generation.parameters.speed === 'number' ? generation.parameters.speed : undefined, emotion: typeof generation.parameters.emotion === 'string' ? generation.parameters.emotion : undefined, correlationId: `retry-${randomUUID()}` });
      return reply.code(result.created ? 202 : 200).send({ ...result.generation, jobId: result.job.id, deduplicated: true });
    } catch (error) { return fail(reply, 409, 'SPEECH_GENERATION_RETRY_CONFLICT', error instanceof Error ? error.message : 'Unable to retry Speech Generation'); }
  });
  app.get('/api/v1/projects/:projectId/digital-human/speech-generations/:generationId/subtitles', async (request, reply) => {
    const params = request.params as { projectId: string; generationId: string }; const query = request.query as { format?: string }; const generation = await deps.digitalHuman.getSpeechGeneration(params.projectId, params.generationId);
    if (!generation) return fail(reply, 404, 'SPEECH_GENERATION_NOT_FOUND', 'Speech Generation not found');
    if (generation.status !== 'SUCCEEDED' || !generation.durationMs) return fail(reply, 409, 'SPEECH_GENERATION_NOT_READY', 'Speech Generation has no measured duration yet');
    const timeline = await new SyntheticTimingProvider().align({ text: generation.text, durationMs: generation.durationMs, language: String(generation.parameters.language || 'zh') }); const format = query.format || 'json';
    const persistSubtitle = async (subtitleFormat: 'srt' | 'ass', body: string): Promise<string | undefined> => {
      const existing = deps.assets ? await deps.assets.getReadyDigitalHumanSubtitle(params.projectId, generation.id, subtitleFormat) : null;
      if (existing) return existing.id;
      if (!deps.assetService || !deps.storage) return undefined;
      const tempPath = join(deps.storage.root, 'staging', `digital-human-${generation.id}.${subtitleFormat}`);
      await mkdir(join(deps.storage.root, 'staging'), { recursive: true });
      await writeFile(tempPath, body, 'utf8');
      try {
        const asset = await deps.assetService.importFile({ projectId: params.projectId, sourcePath: tempPath, kind: 'TEXT', role: 'OUTPUT', skipProbe: true, metadata: { format: subtitleFormat, digitalHuman: { speechGenerationId: generation.id, format: subtitleFormat } } });
        return asset.id;
      } finally { await rm(tempPath, { force: true }); }
    };
    if (format === 'srt') { const body = subtitleTimelineToSrt(timeline); const assetId = await persistSubtitle('srt', body); if (assetId) reply.header('x-contentos-asset-id', assetId); return reply.type('application/x-subrip; charset=utf-8').send(body); }
    if (format === 'ass') { const body = subtitleTimelineToAss(timeline); const assetId = await persistSubtitle('ass', body); if (assetId) reply.header('x-contentos-asset-id', assetId); return reply.type('text/x-ssa; charset=utf-8').send(body); }
    if (format !== 'json' && format !== 'manifest') return fail(reply, 422, 'SUBTITLE_FORMAT_INVALID', 'Subtitle format must be json, manifest, srt or ass');
    return { timeline, subtitles: subtitleTimelineToManifestCues(timeline) };
  });
  app.post('/api/v1/projects/:projectId/digital-human/avatar-generations', async (request, reply) => {
    const parsed = avatarGenerationInput.safeParse(request.body); if (!parsed.success) return invalid(reply, parsed.error.issues);
    const id = projectId(request);
    const runtimeProvider = configuredProviderId(deps, 'avatar');
    if (runtimeProvider && parsed.data.provider && parsed.data.provider !== runtimeProvider) return providerMismatch(reply, 'AVATAR', runtimeProvider, parsed.data.provider);
    const provider = runtimeProvider || parsed.data.provider;
    const existing = await deps.digitalHuman.findAvatarGenerationForRequest({ projectId: id, ...parsed.data, ...(provider ? { provider } : {}) });
    if (!existing || existing.status === 'FAILED' || existing.status === 'CANCELLED') { const preflight = await runAvatarPreflight(id, parsed.data, deps); if (preflight.status === 'BLOCKED') return preflightFailure(reply, preflight); }
    try { const result = await deps.digitalHuman.createAvatarGeneration({ projectId: id, ...parsed.data, ...(provider ? { provider } : {}), correlationId: parsed.data.correlationId || `api-${randomUUID()}` }); return reply.code(result.created ? 202 : 200).send({ ...result.generation, jobId: result.job.id, deduplicated: !result.created }); } catch (error) { if (error instanceof DigitalHumanDurationError) return reply.code(409).send({ error: { code: error.code, message: error.message, details: error.details } }); return fail(reply, 409, 'AVATAR_GENERATION_CONFLICT', error instanceof Error ? error.message : 'Unable to create Avatar Generation'); }
  });
  app.get('/api/v1/projects/:projectId/digital-human/avatar-generations', async (request) => ({ items: await deps.digitalHuman.listAvatarGenerations(projectId(request)) }));
  app.get('/api/v1/projects/:projectId/digital-human/avatar-generations/:generationId', async (request, reply) => { const params = request.params as { projectId: string; generationId: string }; const generation = await deps.digitalHuman.getAvatarGeneration(params.projectId, params.generationId); return generation || fail(reply, 404, 'AVATAR_GENERATION_NOT_FOUND', 'Avatar Generation not found'); });
  app.post('/api/v1/projects/:projectId/digital-human/avatar-generations/:generationId/cancel', async (request, reply) => {
    const params = request.params as { projectId: string; generationId: string }; const generation = await deps.digitalHuman.getAvatarGeneration(params.projectId, params.generationId);
    if (!generation) return fail(reply, 404, 'AVATAR_GENERATION_NOT_FOUND', 'Avatar Generation not found');
    if (generation.status === 'CANCELLED') return { ...generation, cancelRequested: false };
    if (generation.status === 'SUCCEEDED' || generation.status === 'FAILED') return fail(reply, 409, 'AVATAR_GENERATION_NOT_CANCELLABLE', 'Only active Avatar Generations can be cancelled');
    if (generation.externalTaskId && deps.providers?.avatar.cancelTask) {
      try { await deps.providers.avatar.cancelTask(generation.externalTaskId); }
      catch (error) { return fail(reply, 502, 'AVATAR_PROVIDER_CANCEL_FAILED', error instanceof Error ? error.message : 'Avatar provider cancellation failed'); }
    }
    await deps.jobs.requestCancel(generation.jobId); await deps.digitalHuman.cancelAvatar(generation.id);
    return { ...((await deps.digitalHuman.getAvatarGeneration(params.projectId, params.generationId)) || generation), cancelRequested: true };
  });
  app.post('/api/v1/projects/:projectId/digital-human/avatar-generations/:generationId/retry', async (request, reply) => {
    const params = request.params as { projectId: string; generationId: string }; const generation = await deps.digitalHuman.getAvatarGeneration(params.projectId, params.generationId);
    if (!generation) return fail(reply, 404, 'AVATAR_GENERATION_NOT_FOUND', 'Avatar Generation not found');
    if (generation.status !== 'FAILED' && generation.status !== 'CANCELLED') return fail(reply, 409, 'AVATAR_GENERATION_NOT_RETRYABLE', 'Only failed or cancelled Avatar Generations can be retried');
    const runtimeProvider = configuredProviderId(deps, 'avatar');
    if (runtimeProvider && generation.provider !== runtimeProvider) return providerMismatch(reply, 'AVATAR', runtimeProvider, generation.provider);
    const job = await deps.jobs.get(generation.jobId);
    if (!job) return fail(reply, 409, 'AVATAR_GENERATION_JOB_NOT_FOUND', 'Avatar Generation Job not found');
    if (job.state !== 'FAILED' && job.state !== 'CANCELLED') return fail(reply, 409, 'AVATAR_GENERATION_JOB_NOT_TERMINAL', 'Avatar Generation Job is still active; retry after cancellation or failure completes');
    const preflight = await runAvatarPreflight(params.projectId, { avatarProfileId: generation.avatarProfileId, avatarClipId: generation.avatarClipId, speechAssetId: generation.speechAssetId, sourceInMs: generation.sourceInMs }, deps); if (preflight.status === 'BLOCKED') return preflightFailure(reply, preflight);
    try {
      const parameters = generation.provenance.parameters && typeof generation.provenance.parameters === 'object' && !Array.isArray(generation.provenance.parameters) ? generation.provenance.parameters as Record<string, unknown> : {};
      const result = await deps.digitalHuman.createAvatarGeneration({ projectId: params.projectId, avatarProfileId: generation.avatarProfileId, avatarClipId: generation.avatarClipId, speechAssetId: generation.speechAssetId, sourceInMs: generation.sourceInMs, provider: runtimeProvider || generation.provider, model: generation.model || undefined, parameters, correlationId: `retry-${randomUUID()}` });
      return reply.code(result.created ? 202 : 200).send({ ...result.generation, jobId: result.job.id, deduplicated: true });
    } catch (error) { return fail(reply, 409, 'AVATAR_GENERATION_RETRY_CONFLICT', error instanceof Error ? error.message : 'Unable to retry Avatar Generation'); }
  });
}
