import { mkdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { JobRunner, type JobRecord, type JobService } from '../../../packages/modules/job/src/index.js';
import { DigitalHumanProviderError, DigitalHumanService } from '../../../packages/modules/digital-human/src/index.js';
import type { AvatarProvider, ProviderMediaStaging, SpeechProvider } from '../../../packages/contracts/src/index.js';
import { AssetCatalogService, AssetService } from '../../../packages/modules/asset/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';

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
  maxRemoteResultBytes?: number;
}
export interface DigitalHumanWorkerInvocation { jobId: string; }

function payloadOf(job: JobRecord): { generationId: string; projectId: string; kind: 'SPEECH' | 'AVATAR'; correlationId: string } {
  const payload = job.payload as Record<string, unknown>;
  if (payload.schemaVersion !== 'DIGITAL_HUMAN_JOB_PAYLOAD_V1' || typeof payload.generationId !== 'string' || typeof payload.projectId !== 'string' || typeof payload.correlationId !== 'string' || !['SPEECH', 'AVATAR'].includes(String(payload.kind))) throw Object.assign(new Error('Invalid Digital Human Job payload'), { code: 'DIGITAL_HUMAN_PAYLOAD_INVALID', retryable: false });
  if (payload.projectId !== job.projectId) throw Object.assign(new Error('Digital Human Job project mismatch'), { code: 'DIGITAL_HUMAN_PROJECT_MISMATCH', retryable: false });
  return { generationId: payload.generationId, projectId: payload.projectId, kind: payload.kind as 'SPEECH' | 'AVATAR', correlationId: payload.correlationId };
}

const DEFAULT_MAX_REMOTE_RESULT_BYTES = 500 * 1024 * 1024;

function remoteResultLimit(deps: DigitalHumanWorkerDependencies): number {
  const value = deps.maxRemoteResultBytes ?? DEFAULT_MAX_REMOTE_RESULT_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) throw Object.assign(new Error('Invalid remote result size limit'), { code: 'AVATAR_RESULT_LIMIT_INVALID', retryable: false });
  return value;
}

async function streamRemoteResult(response: Response, tempPath: string, maxBytes: number): Promise<void> {
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

async function processSpeech(job: JobRecord, attemptId: string, signal: AbortSignal, payload: ReturnType<typeof payloadOf>, deps: DigitalHumanWorkerDependencies): Promise<unknown> {
  const generation = await deps.digitalHuman.getSpeechGeneration(payload.projectId, payload.generationId); if (!generation) throw Object.assign(new Error('Speech Generation not found'), { code: 'SPEECH_GENERATION_NOT_FOUND', retryable: false });
  if (generation.status === 'SUCCEEDED') return { generationId: generation.id, outputAssetId: generation.outputAssetId, state: generation.status };
  await deps.digitalHuman.markSpeechRunning(generation.id);
  try {
    const voice = await deps.digitalHuman.getVoiceProfile(payload.projectId, generation.voiceProfileId); if (!voice) throw Object.assign(new Error('Voice Profile not found'), { code: 'VOICE_PROFILE_NOT_FOUND', retryable: false });
    const reference = voice.referenceAssetId ? await deps.assets.getProjectAsset(payload.projectId, voice.referenceAssetId) : null;
    if (voice.referenceAssetId && !reference) throw Object.assign(new Error('Voice reference asset not found'), { code: 'VOICE_REFERENCE_ASSET_NOT_READY', retryable: false });
    signal.throwIfAborted();
    const result = await deps.speechProvider.generateSpeech({ requestId: generation.id, projectId: payload.projectId, jobId: job.id, attemptId, correlationId: payload.correlationId, text: generation.text, language: String(generation.parameters.language || voice.language), speed: Number(generation.parameters.speed || voice.defaultSpeed), emotion: String(generation.parameters.emotion || voice.defaultEmotion), ...(reference ? { referenceAudioPath: deps.storage.objectPath(reference.storageKey) } : {}), ...(voice.providerVoiceId ? { providerVoiceId: voice.providerVoiceId } : {}) });
    signal.throwIfAborted();
    if (!Number.isFinite(result.durationMs) || result.durationMs <= 0) throw Object.assign(new Error('Speech provider returned an invalid duration'), { code: 'SPEECH_DURATION_INVALID', retryable: false });
    const asset = await deps.assetService.importFile({ projectId: payload.projectId, sourcePath: result.outputPath, kind: 'AUDIO', role: 'OUTPUT', metadata: { digitalHuman: { generationId: generation.id, provider: result.providerId, model: result.model, modelVersion: result.modelVersion } } });
    signal.throwIfAborted();
    const imported = await deps.assets.getProjectAsset(payload.projectId, asset.id); const measuredDurationMs = Number(imported?.metadata.durationMs); const durationMs = Number.isFinite(measuredDurationMs) && measuredDurationMs > 0 ? measuredDurationMs : result.durationMs;
    const completed = await deps.digitalHuman.completeSpeech(generation.id, { outputAssetId: asset.id, durationMs, latencyMs: result.latencyMs, modelVersion: result.modelVersion, provenance: { ...result.provenance, provider: result.providerId, model: result.model, modelVersion: result.modelVersion, voiceProfileId: generation.voiceProfileId, referenceAssetId: voice.referenceAssetId, referenceChecksum: reference?.checksum || null, textHash: generation.textHash, parameters: generation.parameters, durationMs, providerDurationMs: result.durationMs, latencyMs: result.latencyMs } });
    if (!completed) throw Object.assign(new Error('Speech Generation is no longer active'), { code: 'GENERATION_NOT_ACTIVE', retryable: false });
    return { generationId: generation.id, outputAssetId: asset.id, state: 'SUCCEEDED' };
  } catch (error) {
    if (signal.aborted) { await deps.digitalHuman.cancelSpeech(generation.id); throw error; }
    const providerError = error instanceof DigitalHumanProviderError ? error : null;
    await deps.digitalHuman.failSpeech(generation.id, { code: providerError?.code || 'SPEECH_GENERATION_FAILED', message: error instanceof Error ? error.message.slice(0, 200) : 'Speech generation failed' });
    throw error;
  }
}

async function processAvatar(job: JobRecord, attemptId: string, signal: AbortSignal, payload: ReturnType<typeof payloadOf>, deps: DigitalHumanWorkerDependencies): Promise<unknown> {
  const generation = await deps.digitalHuman.getAvatarGeneration(payload.projectId, payload.generationId); if (!generation) throw Object.assign(new Error('Avatar Generation not found'), { code: 'AVATAR_GENERATION_NOT_FOUND', retryable: false });
  if (generation.status === 'SUCCEEDED') return { generationId: generation.id, outputAssetId: generation.outputAssetId, state: generation.status };
  await deps.digitalHuman.markAvatarRunning(generation.id);
  let remoteTaskId = generation.externalTaskId;
  try {
    const clip = await deps.digitalHuman.getAvatarClip(payload.projectId, generation.avatarClipId); const video = clip ? await deps.assets.getProjectAsset(payload.projectId, clip.assetId) : null; const audio = video ? await deps.assets.getProjectAsset(payload.projectId, generation.speechAssetId) : null;
    if (!clip || !video || video.kind !== 'VIDEO' || video.lifecycle !== 'READY') throw Object.assign(new Error('Avatar source video is not ready'), { code: 'AVATAR_CLIP_ASSET_NOT_READY', retryable: false });
    if (!audio || audio.kind !== 'AUDIO' || audio.lifecycle !== 'READY') throw Object.assign(new Error('Speech asset is not ready'), { code: 'SPEECH_ASSET_NOT_READY', retryable: false });
    const videoDurationMs = Number(video.metadata.durationMs); const audioDurationMs = Number(audio.metadata.durationMs);
    if (!Number.isFinite(videoDurationMs) || videoDurationMs <= 0) throw Object.assign(new Error('Avatar source video duration is invalid'), { code: 'AVATAR_CLIP_DURATION_INVALID', retryable: false });
    if (!Number.isFinite(audioDurationMs) || audioDurationMs <= 0) throw Object.assign(new Error('Speech asset duration is invalid'), { code: 'SPEECH_ASSET_DURATION_INVALID', retryable: false });
    const capabilities = await deps.avatarProvider.getCapabilities(); const videoFormat = String(video.metadata.format || '').toLowerCase().replace(/^\./, '').split('/').pop() || ''; const audioFormat = String(audio.metadata.format || '').toLowerCase().replace(/^\./, '').split('/').pop() || '';
    if (videoFormat && capabilities.supportedFormats.length > 0 && !capabilities.supportedFormats.some((format) => format.toLowerCase().replace(/^\./, '') === videoFormat)) throw Object.assign(new Error(`Avatar provider does not support ${videoFormat} video input`), { code: 'AVATAR_VIDEO_FORMAT_UNSUPPORTED', retryable: false });
    if (capabilities.supportedAudioFormats?.length && audioFormat && !capabilities.supportedAudioFormats.some((format) => format.toLowerCase().replace(/^\./, '') === audioFormat)) throw Object.assign(new Error(`Avatar provider does not support ${audioFormat} audio input`), { code: 'AVATAR_AUDIO_FORMAT_UNSUPPORTED', retryable: false });
    if (capabilities.maxDurationSeconds !== undefined && videoDurationMs > capabilities.maxDurationSeconds * 1_000) throw Object.assign(new Error('Avatar source video exceeds provider duration limit'), { code: 'AVATAR_DURATION_EXCEEDS_PROVIDER_LIMIT', retryable: false });
    signal.throwIfAborted();
    const existingTask = generation.externalTaskId ? await deps.avatarProvider.getTask(generation.externalTaskId) : null;
    const replaceTerminalTask = existingTask && (existingTask.status === 'FAILED' || existingTask.status === 'CANCELLED');
    const task = !replaceTerminalTask && existingTask ? existingTask : await deps.avatarProvider.submitLipSync({ requestId: generation.id, projectId: payload.projectId, jobId: job.id, attemptId, correlationId: payload.correlationId, audioUrl: (await deps.staging.stageAsset(audio.id)).publicUrl, videoUrl: (await deps.staging.stageAsset(video.id)).publicUrl, ...(generation.model ? { model: generation.model } : {}), parameters: generation.provenance.parameters && typeof generation.provenance.parameters === 'object' ? generation.provenance.parameters as Record<string, unknown> : {} });
    remoteTaskId = task.externalTaskId;
    if (!generation.externalTaskId) await deps.digitalHuman.markAvatarWaiting(generation.id, task.externalTaskId, { provider: task.providerId, externalTaskId: task.externalTaskId });
    else if (replaceTerminalTask) await deps.digitalHuman.replaceAvatarWaiting(generation.id, task.externalTaskId, { provider: task.providerId, externalTaskId: task.externalTaskId });
    if (task.status === 'QUEUED' || task.status === 'RUNNING') throw Object.assign(new Error('Avatar provider task is still running'), { code: 'EXTERNAL_TASK_PENDING', retryable: true });
    const taskError = task as { errorCode?: string; errorMessage?: string };
    if (task.status === 'FAILED' || task.status === 'CANCELLED' || !task.outputUrl) throw Object.assign(new Error(taskError.errorMessage || 'Avatar provider task failed'), { code: taskError.errorCode || 'AVATAR_PROVIDER_FAILED', retryable: false });
    signal.throwIfAborted();
    if (!/^https?:\/\//i.test(task.outputUrl)) throw Object.assign(new Error('Avatar provider returned an unsafe output URL'), { code: 'AVATAR_RESULT_URL_INVALID', retryable: false });
    const fetchImpl = deps.fetchImpl || fetch; const response = await fetchImpl(task.outputUrl, { signal }); if (!response.ok) throw Object.assign(new Error('Unable to download avatar result'), { code: 'AVATAR_RESULT_DOWNLOAD_FAILED', retryable: response.status >= 500 });
    const tempPath = join(deps.storage.root, 'staging', `${generation.id}.avatar.mp4`); await mkdir(join(deps.storage.root, 'staging'), { recursive: true }); await streamRemoteResult(response, tempPath, remoteResultLimit(deps));
    try {
      const asset = await deps.assetService.importFile({ projectId: payload.projectId, sourcePath: tempPath, kind: 'VIDEO', role: 'OUTPUT', metadata: { digitalHuman: { generationId: generation.id, provider: task.providerId, externalTaskId: task.externalTaskId } } });
      const imported = await deps.assets.getReadySourceAsset(payload.projectId, asset.id, 'VIDEO'); const metadata = imported?.metadata || {};
      signal.throwIfAborted();
      const completed = await deps.digitalHuman.completeAvatar(generation.id, { outputAssetId: asset.id, durationMs: typeof metadata.durationMs === 'number' ? metadata.durationMs : undefined, model: task.model, modelVersion: task.modelVersion, costAmount: task.costAmount, costCurrency: task.costCurrency, provenance: { provider: task.providerId, model: task.model || generation.model, modelVersion: task.modelVersion || null, avatarProfileId: generation.avatarProfileId, avatarClipId: generation.avatarClipId, speechAssetId: generation.speechAssetId, sourceVideoAssetId: video.id, externalTaskId: task.externalTaskId, costAmount: task.costAmount ?? null, costCurrency: task.costCurrency ?? null, ...(task.provenance || {}) } });
      if (!completed) throw Object.assign(new Error('Avatar Generation is no longer active'), { code: 'GENERATION_NOT_ACTIVE', retryable: false });
      return { generationId: generation.id, outputAssetId: asset.id, state: 'SUCCEEDED' };
    } finally { await rm(tempPath, { force: true }); }
  } catch (error) {
    if (signal.aborted) {
      if (remoteTaskId && deps.avatarProvider.cancelTask) await deps.avatarProvider.cancelTask(remoteTaskId).catch(() => undefined);
      await deps.digitalHuman.cancelAvatar(generation.id);
      throw error;
    }
    if ((error as { code?: unknown }).code === 'EXTERNAL_TASK_PENDING') throw error;
    await deps.digitalHuman.failAvatar(generation.id, { code: typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'AVATAR_GENERATION_FAILED', message: error instanceof Error ? error.message.slice(0, 200) : 'Avatar generation failed' });
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
