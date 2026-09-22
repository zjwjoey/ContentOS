import { mkdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { JobRunner, type JobLeaseCancellationHandler, type JobRecord, type JobService } from '../../../packages/modules/job/src/index.js';
import { DigitalHumanDurationError, DigitalHumanProviderError, DigitalHumanService, normalizeAvatarTiming, safeFetchRemoteMedia, speechCapabilityError, type RemoteMediaResolver } from '../../../packages/modules/digital-human/src/index.js';
import type { AvatarProvider, ProviderMediaStaging, SpeechProvider } from '../../../packages/contracts/src/index.js';
import { AssetCatalogService, AssetService } from '../../../packages/modules/asset/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { DIGITAL_HUMAN_JOB_TYPES } from './job-types.js';

export interface DigitalHumanWorkerDependencies {
  jobs: JobService;
  digitalHuman: DigitalHumanService;
  assets: AssetCatalogService;
  assetService: AssetService;
  storage: LocalStorageProvider;
  speechProvider: SpeechProvider;
  avatarProvider: AvatarProvider;
  staging: ProviderMediaStaging;
  fetchImpl?: typeof fetch;
  resolveRemoteMedia?: RemoteMediaResolver;
  probeRemoteResult?: (path: string, signal?: AbortSignal) => Promise<RemoteVideoProbe>;
  maxRemoteResultBytes?: number;
  remoteResultTimeoutMs?: number;
}
export interface DigitalHumanWorkerInvocation { jobId: string; }
export interface RemoteVideoProbe { format: string; durationMs: number; width: number; height: number; videoCodec?: string; }
export interface RemoteAvatarResultValidationOptions {
  fetchImpl: typeof fetch;
  resolveRemoteMedia?: RemoteMediaResolver;
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  tempPath: string;
  probe: (path: string, signal?: AbortSignal) => Promise<RemoteVideoProbe>;
}

function payloadOf(job: JobRecord): { generationId: string; projectId: string; kind: 'SPEECH' | 'AVATAR'; correlationId: string; timing?: { sourceVideoAssetId?: string; audioAssetId?: string; sourceInMs?: number; sourceOutMs?: number; targetDurationMs?: number } } {
  const payload = job.payload as Record<string, unknown>;
  if (payload.schemaVersion !== 'DIGITAL_HUMAN_JOB_PAYLOAD_V1' || typeof payload.generationId !== 'string' || typeof payload.projectId !== 'string' || typeof payload.correlationId !== 'string' || !['SPEECH', 'AVATAR'].includes(String(payload.kind))) throw Object.assign(new Error('Invalid Digital Human Job payload'), { code: 'DIGITAL_HUMAN_PAYLOAD_INVALID', retryable: false });
  if (payload.projectId !== job.projectId) throw Object.assign(new Error('Digital Human Job project mismatch'), { code: 'DIGITAL_HUMAN_PROJECT_MISMATCH', retryable: false });
  const rawTiming = payload.timing && typeof payload.timing === 'object' ? payload.timing as Record<string, unknown> : undefined;
  return { generationId: payload.generationId, projectId: payload.projectId, kind: payload.kind as 'SPEECH' | 'AVATAR', correlationId: payload.correlationId, ...(rawTiming ? { timing: { ...(typeof rawTiming.sourceVideoAssetId === 'string' ? { sourceVideoAssetId: rawTiming.sourceVideoAssetId } : {}), ...(typeof rawTiming.audioAssetId === 'string' ? { audioAssetId: rawTiming.audioAssetId } : {}), ...(typeof rawTiming.sourceInMs === 'number' ? { sourceInMs: rawTiming.sourceInMs } : {}), ...(typeof rawTiming.sourceOutMs === 'number' ? { sourceOutMs: rawTiming.sourceOutMs } : {}), ...(typeof rawTiming.targetDurationMs === 'number' ? { targetDurationMs: rawTiming.targetDurationMs } : {}) } } : {}) };
}

export function createDigitalHumanLeaseCancellationHandler(deps: DigitalHumanWorkerDependencies): JobLeaseCancellationHandler {
  return async (job) => {
    if (!DIGITAL_HUMAN_JOB_TYPES.includes(job.type as typeof DIGITAL_HUMAN_JOB_TYPES[number])) return false;
    const payload = job.payload && typeof job.payload === 'object' ? job.payload as Record<string, unknown> : {};
    const projectId = typeof payload.projectId === 'string' ? payload.projectId : job.projectId;
    const generationId = typeof payload.generationId === 'string' ? payload.generationId : '';
    if (!projectId || !generationId) return true;
    if (payload.kind === 'AVATAR') {
      const generation = await deps.digitalHuman.getAvatarGeneration(projectId, generationId);
      if (generation?.externalTaskId && deps.avatarProvider.cancelTask) await deps.avatarProvider.cancelTask(generation.externalTaskId);
      if (generation) await deps.digitalHuman.cancelAvatar(generation.id);
    } else if (payload.kind === 'SPEECH') {
      const generation = await deps.digitalHuman.getSpeechGeneration(projectId, generationId);
      if (generation) await deps.digitalHuman.cancelSpeech(generation.id);
    }
    return true;
  };
}

const DEFAULT_MAX_REMOTE_RESULT_BYTES = 500 * 1024 * 1024;
const DEFAULT_REMOTE_RESULT_TIMEOUT_MS = 300_000;

function remoteResultLimit(deps: DigitalHumanWorkerDependencies): number {
  const value = deps.maxRemoteResultBytes ?? DEFAULT_MAX_REMOTE_RESULT_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) throw Object.assign(new Error('Invalid remote result size limit'), { code: 'AVATAR_RESULT_LIMIT_INVALID', retryable: false });
  return value;
}

function remoteResultTimeout(deps: DigitalHumanWorkerDependencies): number {
  const value = deps.remoteResultTimeoutMs ?? DEFAULT_REMOTE_RESULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) throw Object.assign(new Error('Invalid remote result timeout'), { code: 'AVATAR_RESULT_TIMEOUT_INVALID', retryable: false });
  return value;
}

async function fetchRemoteResult(fetchImpl: typeof fetch, url: string, signal: AbortSignal, timeout: number, resolveRemoteMedia?: RemoteMediaResolver): Promise<Response> {
  const controller = new AbortController(); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout); const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  try { return await safeFetchRemoteMedia(url, { fetchImpl, ...(resolveRemoteMedia ? { resolveAll: resolveRemoteMedia } : {}), signal: controller.signal }); }
  catch (error) { if (timedOut) throw Object.assign(new Error('Avatar provider result download timed out'), { code: 'AVATAR_RESULT_DOWNLOAD_TIMEOUT', retryable: true }); throw error; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

async function streamRemoteResult(response: Response, tempPath: string, maxBytes: number): Promise<void> {
  const contentType = (response.headers.get('content-type') || '').split(';', 1)[0]?.trim().toLowerCase();
  if (contentType && ['text/html', 'text/plain', 'application/json', 'application/xml', 'text/xml'].includes(contentType)) throw Object.assign(new Error(`Avatar provider returned an invalid media content type: ${contentType}`), { code: 'AVATAR_RESULT_CONTENT_TYPE_INVALID', retryable: false });
  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw Object.assign(new Error('Avatar provider result exceeds the configured size limit'), { code: 'AVATAR_RESULT_TOO_LARGE', retryable: false });
  if (!response.body) throw Object.assign(new Error('Avatar provider returned an empty response body'), { code: 'AVATAR_RESULT_DOWNLOAD_FAILED', retryable: true });
  let total = 0;
  const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { total += chunk.byteLength; if (total > maxBytes) callback(Object.assign(new Error('Avatar provider result exceeds the configured size limit'), { code: 'AVATAR_RESULT_TOO_LARGE', retryable: false })); else callback(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(response.body as globalThis.ReadableStream<Uint8Array>), limiter, createWriteStream(tempPath, { flags: 'wx' }));
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  if (total === 0) { await rm(tempPath, { force: true }); throw Object.assign(new Error('Avatar provider returned an empty response body'), { code: 'AVATAR_RESULT_DOWNLOAD_FAILED', retryable: true }); }
}

export function validateRemoteVideoProbe(probe: RemoteVideoProbe): void {
  if (!probe || typeof probe !== 'object' || !Number.isFinite(probe.durationMs) || probe.durationMs <= 0 || !Number.isFinite(probe.width) || probe.width <= 0 || !Number.isFinite(probe.height) || probe.height <= 0 || !probe.videoCodec?.trim() || !probe.format || probe.format === 'unknown') throw Object.assign(new Error('Avatar provider result is not a valid video'), { code: 'AVATAR_RESULT_INVALID', retryable: false });
}

export async function downloadAndValidateRemoteAvatarResult(url: string, options: RemoteAvatarResultValidationOptions): Promise<RemoteVideoProbe> {
  const response = await fetchRemoteResult(options.fetchImpl, url, options.signal, options.timeoutMs, options.resolveRemoteMedia);
  if (!response.ok) throw Object.assign(new Error('Unable to download avatar result'), { code: 'AVATAR_RESULT_DOWNLOAD_FAILED', retryable: response.status >= 500 });
  await streamRemoteResult(response, options.tempPath, options.maxBytes);
  try {
    let probe: RemoteVideoProbe;
    try { probe = await options.probe(options.tempPath, options.signal); validateRemoteVideoProbe(probe); }
    catch (error) { if (options.signal.aborted) throw error; if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') throw error; throw Object.assign(new Error('Avatar provider result could not be validated as video'), { code: 'AVATAR_RESULT_INVALID', retryable: false, cause: error }); }
    return probe;
  } catch (error) {
    await rm(options.tempPath, { force: true });
    throw error;
  }
}

async function processSpeech(job: JobRecord, attemptId: string, signal: AbortSignal, payload: ReturnType<typeof payloadOf>, deps: DigitalHumanWorkerDependencies): Promise<unknown> {
  const generation = await deps.digitalHuman.getSpeechGeneration(payload.projectId, payload.generationId); if (!generation) throw Object.assign(new Error('Speech Generation not found'), { code: 'SPEECH_GENERATION_NOT_FOUND', retryable: false });
  if (generation.status === 'SUCCEEDED') return { generationId: generation.id, outputAssetId: generation.outputAssetId, state: generation.status };
  await deps.digitalHuman.markSpeechRunning(generation.id);
  try {
    if (deps.speechProvider?.providerId && generation.provider !== deps.speechProvider.providerId) throw Object.assign(new Error('Speech Generation provider does not match the configured runtime provider'), { code: 'SPEECH_PROVIDER_IDENTITY_MISMATCH', retryable: false });
    const voice = await deps.digitalHuman.getVoiceProfile(payload.projectId, generation.voiceProfileId); if (!voice) throw Object.assign(new Error('Voice Profile not found'), { code: 'VOICE_PROFILE_NOT_FOUND', retryable: false });
    const reference = voice.referenceAssetId ? await deps.assets.getProjectAsset(payload.projectId, voice.referenceAssetId) : null;
    if (voice.referenceAssetId && !reference) throw Object.assign(new Error('Voice reference asset not found'), { code: 'VOICE_REFERENCE_ASSET_NOT_READY', retryable: false });
    const capabilities = await deps.speechProvider.getCapabilities();
    if (deps.speechProvider?.providerId && capabilities.providerId !== deps.speechProvider.providerId) throw Object.assign(new Error('Speech provider capability identity does not match the configured runtime provider'), { code: 'SPEECH_PROVIDER_IDENTITY_MISMATCH', retryable: false });
    const language = String(generation.parameters.language || voice.language); const speed = Number(generation.parameters.speed || voice.defaultSpeed); const emotion = String(generation.parameters.emotion || voice.defaultEmotion);
    const capabilityError = speechCapabilityError(capabilities, { text: generation.text, language, speed, emotion, hasReferenceAudio: Boolean(reference), hasProviderVoiceId: Boolean(voice.providerVoiceId) });
    if (capabilityError) throw Object.assign(new Error(capabilityError.message), { code: capabilityError.code, retryable: false });
    signal.throwIfAborted();
    const result = await deps.speechProvider.generateSpeech({ requestId: generation.id, projectId: payload.projectId, jobId: job.id, attemptId, correlationId: payload.correlationId, text: generation.text, language, speed, emotion, ...(reference ? { referenceAudioPath: deps.storage.objectPath(reference.storageKey) } : {}), ...(voice.providerVoiceId ? { providerVoiceId: voice.providerVoiceId } : {}) });
    signal.throwIfAborted();
    if (deps.speechProvider?.providerId && result.providerId !== deps.speechProvider.providerId) throw Object.assign(new Error('Speech provider returned a mismatched provider identity'), { code: 'SPEECH_PROVIDER_IDENTITY_MISMATCH', retryable: false });
    if (!Number.isFinite(result.durationMs) || result.durationMs <= 0) throw Object.assign(new Error('Speech provider returned an invalid duration'), { code: 'SPEECH_DURATION_INVALID', retryable: false });
    const asset = await deps.assetService.importFile({ projectId: payload.projectId, sourcePath: result.outputPath, kind: 'AUDIO', role: 'OUTPUT', metadata: { digitalHuman: { generationId: generation.id, provider: result.providerId, model: result.model, modelVersion: result.modelVersion } } });
    signal.throwIfAborted();
    const imported = await deps.assets.getProjectAsset(payload.projectId, asset.id); const measuredDurationMs = Number(imported?.metadata.durationMs); const durationMs = Number.isFinite(measuredDurationMs) && measuredDurationMs > 0 ? measuredDurationMs : result.durationMs;
    const completed = await deps.digitalHuman.completeSpeech(generation.id, { outputAssetId: asset.id, durationMs, latencyMs: result.latencyMs, modelVersion: result.modelVersion, provenance: { providerMetadata: result.provenance || null, provider: result.providerId, model: result.model, modelVersion: result.modelVersion, voiceProfileId: generation.voiceProfileId, referenceAssetId: voice.referenceAssetId, referenceChecksum: reference?.checksum || null, textHash: generation.textHash, parameters: generation.parameters, durationMs, providerDurationMs: result.durationMs, latencyMs: result.latencyMs } });
    if (!completed) throw Object.assign(new Error('Speech Generation is no longer active'), { code: 'GENERATION_NOT_ACTIVE', retryable: false });
    return { generationId: generation.id, outputAssetId: asset.id, state: 'SUCCEEDED' };
  } catch (error) {
    if (signal.aborted) { await deps.digitalHuman.cancelSpeech(generation.id); throw error; }
    const providerError = error instanceof DigitalHumanProviderError ? error : null; const errorCode = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : undefined;
    await deps.digitalHuman.failSpeech(generation.id, { code: providerError?.code || errorCode || 'SPEECH_GENERATION_FAILED', message: error instanceof Error ? error.message.slice(0, 200) : 'Speech generation failed' });
    throw error;
  }
}

async function processAvatar(job: JobRecord, attemptId: string, signal: AbortSignal, payload: ReturnType<typeof payloadOf>, deps: DigitalHumanWorkerDependencies): Promise<unknown> {
  const generation = await deps.digitalHuman.getAvatarGeneration(payload.projectId, payload.generationId); if (!generation) throw Object.assign(new Error('Avatar Generation not found'), { code: 'AVATAR_GENERATION_NOT_FOUND', retryable: false });
  if (generation.status === 'SUCCEEDED') return { generationId: generation.id, outputAssetId: generation.outputAssetId, state: generation.status };
  await deps.digitalHuman.markAvatarRunning(generation.id);
  let remoteTaskId = generation.externalTaskId;
  let importedOutput: Awaited<ReturnType<AssetService['importFile']>> | undefined;
  const cleanupUnboundOutputAssociation = async (): Promise<void> => {
    if (!importedOutput?.associationCreated) return;
    const sharedReference = await deps.digitalHuman.hasOtherAvatarOutputReference(payload.projectId, importedOutput.id, generation.id).catch(() => true);
    if (sharedReference) return;
    await deps.assetService.removeProjectAssetAssociation(payload.projectId, importedOutput.id, 'OUTPUT').catch(() => undefined);
  };
  try {
    if (deps.avatarProvider?.providerId && generation.provider !== deps.avatarProvider.providerId) throw Object.assign(new Error('Avatar Generation provider does not match the configured runtime provider'), { code: 'AVATAR_PROVIDER_IDENTITY_MISMATCH', retryable: false });
    const clip = await deps.digitalHuman.getAvatarClip(payload.projectId, generation.avatarClipId); const sourceVideoAssetId = generation.sourceVideoAssetId || payload.timing?.sourceVideoAssetId || clip?.assetId || ''; const audioAssetId = generation.speechAssetId || payload.timing?.audioAssetId || ''; const video = sourceVideoAssetId ? await deps.assets.getProjectAsset(payload.projectId, sourceVideoAssetId) : null; const audio = audioAssetId ? await deps.assets.getProjectAsset(payload.projectId, audioAssetId) : null;
    if (!clip || !video || video.kind !== 'VIDEO' || video.lifecycle !== 'READY') throw Object.assign(new Error('Avatar source video is not ready'), { code: 'AVATAR_CLIP_ASSET_NOT_READY', retryable: false });
    if (!audio || audio.kind !== 'AUDIO' || audio.lifecycle !== 'READY') throw Object.assign(new Error('Speech asset is not ready'), { code: 'SPEECH_ASSET_NOT_READY', retryable: false });
    const videoDurationMs = Number(video.metadata.durationMs); const audioDurationMs = Number(audio.metadata.durationMs);
    if (!Number.isFinite(videoDurationMs) || videoDurationMs <= 0) throw Object.assign(new Error('Avatar source video duration is invalid'), { code: 'AVATAR_CLIP_DURATION_INVALID', retryable: false });
    if (!Number.isFinite(audioDurationMs) || audioDurationMs <= 0) throw Object.assign(new Error('Speech asset duration is invalid'), { code: 'SPEECH_ASSET_DURATION_INVALID', retryable: false });
    const persistedSourceInMs = generation.sourceInMs ?? payload.timing?.sourceInMs ?? 0;
    const persistedTargetDurationMs = generation.targetDurationMs ?? payload.timing?.targetDurationMs;
    let timing;
    try {
      const normalized = normalizeAvatarTiming(video, audio, persistedSourceInMs);
      if (persistedTargetDurationMs !== undefined && persistedTargetDurationMs !== normalized.targetDurationMs) throw Object.assign(new Error('Speech asset duration changed after job creation'), { code: 'AUDIO_DURATION_CHANGED', retryable: false, details: { sourceDurationMs: videoDurationMs, audioDurationMs, requiredDurationMs: persistedTargetDurationMs } });
      const persistedSourceOutMs = generation.sourceOutMs ?? payload.timing?.sourceOutMs;
      if (persistedSourceOutMs !== undefined && persistedSourceOutMs !== null && persistedSourceOutMs !== normalized.sourceOutMs) throw Object.assign(new Error('Persisted source range no longer matches asset timing'), { code: 'SOURCE_RANGE_CHANGED', retryable: false });
      timing = normalized;
    } catch (error) { if (error instanceof DigitalHumanDurationError) throw Object.assign(new Error(error.message), { code: error.code, details: error.details, retryable: false }); throw error; }
    const capabilities = await deps.avatarProvider.getCapabilities();
    if (deps.avatarProvider?.providerId && capabilities.providerId !== deps.avatarProvider.providerId) throw Object.assign(new Error('Avatar provider capability identity does not match the configured runtime provider'), { code: 'AVATAR_PROVIDER_IDENTITY_MISMATCH', retryable: false });
    if (!capabilities.videoToVideo) throw Object.assign(new Error('Avatar provider does not support video-to-video generation for this video clip'), { code: 'AVATAR_VIDEO_TO_VIDEO_UNSUPPORTED', retryable: false });
    const videoFormat = String(video.metadata.format || '').toLowerCase().replace(/^\./, '').split('/').pop() || ''; const audioFormat = String(audio.metadata.format || '').toLowerCase().replace(/^\./, '').split('/').pop() || '';
    if (videoFormat && capabilities.supportedFormats.length > 0 && !capabilities.supportedFormats.some((format) => format.toLowerCase().replace(/^\./, '') === videoFormat)) throw Object.assign(new Error(`Avatar provider does not support ${videoFormat} video input`), { code: 'AVATAR_VIDEO_FORMAT_UNSUPPORTED', retryable: false });
    if (capabilities.supportedAudioFormats?.length && audioFormat && !capabilities.supportedAudioFormats.some((format) => format.toLowerCase().replace(/^\./, '') === audioFormat)) throw Object.assign(new Error(`Avatar provider does not support ${audioFormat} audio input`), { code: 'AVATAR_AUDIO_FORMAT_UNSUPPORTED', retryable: false });
    if (capabilities.maxDurationSeconds !== undefined && timing.targetDurationMs > capabilities.maxDurationSeconds * 1_000) throw Object.assign(new Error('Requested avatar output duration exceeds provider duration limit'), { code: 'AVATAR_DURATION_EXCEEDS_PROVIDER_LIMIT', retryable: false });
    signal.throwIfAborted();
    const existingTask = generation.externalTaskId ? await deps.avatarProvider.getTask(generation.externalTaskId) : null;
    const replaceTerminalTask = existingTask && (existingTask.status === 'FAILED' || existingTask.status === 'CANCELLED');
    const task = !replaceTerminalTask && existingTask ? existingTask : await deps.avatarProvider.submitLipSync({ requestId: generation.id, projectId: payload.projectId, jobId: job.id, attemptId, correlationId: payload.correlationId, audioUrl: (await deps.staging.stageAsset(audio.id, { projectId: payload.projectId })).publicUrl, videoUrl: (await deps.staging.stageAsset(video.id, { projectId: payload.projectId })).publicUrl, sourceVideoAssetId: timing.sourceVideoAssetId, audioAssetId: audio.id, sourceInMs: timing.sourceInMs, sourceOutMs: timing.sourceOutMs, targetDurationMs: timing.targetDurationMs, ...(generation.model ? { model: generation.model } : {}), parameters: generation.provenance.parameters && typeof generation.provenance.parameters === 'object' ? generation.provenance.parameters as Record<string, unknown> : {} });
    remoteTaskId = task.externalTaskId;
    if (!generation.externalTaskId) await deps.digitalHuman.markAvatarWaiting(generation.id, task.externalTaskId, { provider: task.providerId, externalTaskId: task.externalTaskId });
    else if (replaceTerminalTask) await deps.digitalHuman.replaceAvatarWaiting(generation.id, task.externalTaskId, { provider: task.providerId, externalTaskId: task.externalTaskId });
    if (task.status === 'QUEUED' || task.status === 'RUNNING') throw Object.assign(new Error('Avatar provider task is still running'), { code: 'EXTERNAL_TASK_PENDING', retryable: true, defer: true, retryDelayMs: 1_000 });
    const taskError = task as { errorCode?: string; errorMessage?: string };
    if (task.status === 'FAILED' || task.status === 'CANCELLED' || !task.outputUrl) throw Object.assign(new Error(taskError.errorMessage || 'Avatar provider task failed'), { code: taskError.errorCode || 'AVATAR_PROVIDER_FAILED', retryable: false });
    if (deps.avatarProvider?.providerId && task.providerId !== deps.avatarProvider.providerId) throw Object.assign(new Error('Avatar provider task identity does not match the configured runtime provider'), { code: 'AVATAR_PROVIDER_IDENTITY_MISMATCH', retryable: false });
    signal.throwIfAborted();
    const fetchImpl = deps.fetchImpl || fetch;
    const tempPath = join(deps.storage.root, 'staging', `${generation.id}.avatar.mp4`); await mkdir(join(deps.storage.root, 'staging'), { recursive: true });
    if (!deps.probeRemoteResult) throw Object.assign(new Error('Avatar result validation is not configured'), { code: 'AVATAR_RESULT_PROBE_UNAVAILABLE', retryable: false });
    const probe = await downloadAndValidateRemoteAvatarResult(task.outputUrl, { fetchImpl, ...(deps.resolveRemoteMedia ? { resolveRemoteMedia: deps.resolveRemoteMedia } : {}), signal, timeoutMs: remoteResultTimeout(deps), maxBytes: remoteResultLimit(deps), tempPath, probe: deps.probeRemoteResult });
    const durationToleranceMs = 250;
    if (Math.abs(probe.durationMs - timing.targetDurationMs) > durationToleranceMs) throw Object.assign(new Error('Avatar provider output duration does not match the audio duration'), { code: 'AVATAR_OUTPUT_DURATION_MISMATCH', retryable: false, details: { outputDurationMs: probe.durationMs, audioDurationMs: timing.targetDurationMs, toleranceMs: durationToleranceMs } });
    try {
      importedOutput = await deps.assetService.importFile({ projectId: payload.projectId, sourcePath: tempPath, kind: 'VIDEO', role: 'OUTPUT', metadata: { durationMs: probe.durationMs, width: probe.width, height: probe.height, format: probe.format, ...(probe.videoCodec ? { codec: probe.videoCodec } : {}), digitalHuman: { generationId: generation.id, provider: task.providerId, externalTaskId: task.externalTaskId, providerMetadata: task.provenance || null } } });
      const imported = await deps.assets.getReadySourceAsset(payload.projectId, importedOutput.id, 'VIDEO'); const metadata = imported?.metadata || probe;
      signal.throwIfAborted();
      const completed = await deps.digitalHuman.completeAvatar(generation.id, { outputAssetId: importedOutput.id, durationMs: typeof metadata.durationMs === 'number' ? metadata.durationMs : probe.durationMs, model: task.model, modelVersion: task.modelVersion, costAmount: task.costAmount, costCurrency: task.costCurrency, billingQuantity: task.billingQuantity, billingUnit: task.billingUnit, provenance: { provider: task.providerId, model: task.model || generation.model, modelVersion: task.modelVersion || null, avatarProfileId: generation.avatarProfileId, avatarClipId: generation.avatarClipId, speechAssetId: generation.speechAssetId, sourceVideoAssetId: video.id, externalTaskId: task.externalTaskId, costAmount: task.costAmount ?? null, costCurrency: task.costCurrency ?? null, billingQuantity: task.billingQuantity ?? null, billingUnit: task.billingUnit ?? null, probe: { durationMs: probe.durationMs, width: probe.width, height: probe.height, format: probe.format, codec: probe.videoCodec || null }, providerMetadata: task.provenance || null } });
      if (!completed) throw Object.assign(new Error('Avatar Generation is no longer active'), { code: 'GENERATION_NOT_ACTIVE', retryable: false });
      return { generationId: generation.id, outputAssetId: importedOutput.id, state: 'SUCCEEDED' };
    } finally { await rm(tempPath, { force: true }); }
  } catch (error) {
    if (signal.aborted) {
      if (remoteTaskId && deps.avatarProvider.cancelTask) await deps.avatarProvider.cancelTask(remoteTaskId).catch(() => undefined);
      try { await deps.digitalHuman.cancelAvatar(generation.id); } finally { await cleanupUnboundOutputAssociation(); }
      throw error;
    }
    if ((error as { code?: unknown }).code === 'EXTERNAL_TASK_PENDING') throw error;
    try { await deps.digitalHuman.failAvatar(generation.id, { code: typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'AVATAR_GENERATION_FAILED', message: error instanceof Error ? error.message.slice(0, 200) : 'Avatar generation failed' }); } finally { await cleanupUnboundOutputAssociation(); }
    throw error;
  }
}

export function createDigitalHumanJobHandler(deps: DigitalHumanWorkerDependencies): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, attemptId, signal) => { const payload = payloadOf(job); return payload.kind === 'SPEECH' ? processSpeech(job, attemptId, signal, payload, deps) : processAvatar(job, attemptId, signal, payload, deps); };
}

export function createDigitalHumanJobRunner(deps: DigitalHumanWorkerDependencies): (invocation: unknown) => Promise<unknown> {
  const handler = createDigitalHumanJobHandler(deps); const runner = new JobRunner(deps.jobs, 'digital-human-worker');
  return async (invocation: unknown) => { const jobId = (invocation as DigitalHumanWorkerInvocation | undefined)?.jobId; if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Digital Human worker invocation requires jobId'); return runner.run(jobId, handler); };
}
