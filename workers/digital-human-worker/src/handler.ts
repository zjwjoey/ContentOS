import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
}
export interface DigitalHumanWorkerInvocation { jobId: string; }

function payloadOf(job: JobRecord): { generationId: string; projectId: string; kind: 'SPEECH' | 'AVATAR'; correlationId: string } {
  const payload = job.payload as Record<string, unknown>;
  if (payload.schemaVersion !== 'DIGITAL_HUMAN_JOB_PAYLOAD_V1' || typeof payload.generationId !== 'string' || typeof payload.projectId !== 'string' || typeof payload.correlationId !== 'string' || !['SPEECH', 'AVATAR'].includes(String(payload.kind))) throw Object.assign(new Error('Invalid Digital Human Job payload'), { code: 'DIGITAL_HUMAN_PAYLOAD_INVALID', retryable: false });
  if (payload.projectId !== job.projectId) throw Object.assign(new Error('Digital Human Job project mismatch'), { code: 'DIGITAL_HUMAN_PROJECT_MISMATCH', retryable: false });
  return { generationId: payload.generationId, projectId: payload.projectId, kind: payload.kind as 'SPEECH' | 'AVATAR', correlationId: payload.correlationId };
}

async function processSpeech(job: JobRecord, attemptId: string, signal: AbortSignal, payload: ReturnType<typeof payloadOf>, deps: DigitalHumanWorkerDependencies): Promise<unknown> {
  const generation = await deps.digitalHuman.getSpeechGeneration(payload.projectId, payload.generationId); if (!generation) throw Object.assign(new Error('Speech Generation not found'), { code: 'SPEECH_GENERATION_NOT_FOUND', retryable: false });
  if (generation.status === 'SUCCEEDED') return { generationId: generation.id, outputAssetId: generation.outputAssetId, state: generation.status };
  await deps.digitalHuman.markSpeechRunning(generation.id); const voice = await deps.digitalHuman.getVoiceProfile(payload.projectId, generation.voiceProfileId); if (!voice) throw Object.assign(new Error('Voice Profile not found'), { code: 'VOICE_PROFILE_NOT_FOUND', retryable: false });
  const reference = voice.referenceAssetId ? await deps.assets.getProjectAsset(payload.projectId, voice.referenceAssetId) : null;
  if (voice.referenceAssetId && !reference) throw Object.assign(new Error('Voice reference asset not found'), { code: 'VOICE_REFERENCE_ASSET_NOT_READY', retryable: false });
  signal.throwIfAborted();
  try {
    const result = await deps.speechProvider.generateSpeech({ requestId: generation.id, projectId: payload.projectId, jobId: job.id, attemptId, correlationId: payload.correlationId, text: generation.text, language: String(generation.parameters.language || voice.language), speed: Number(generation.parameters.speed || voice.defaultSpeed), emotion: String(generation.parameters.emotion || voice.defaultEmotion), ...(reference ? { referenceAudioPath: deps.storage.objectPath(reference.storageKey) } : {}), ...(voice.providerVoiceId ? { providerVoiceId: voice.providerVoiceId } : {}) });
    signal.throwIfAborted();
    const asset = await deps.assetService.importFile({ projectId: payload.projectId, sourcePath: result.outputPath, kind: 'AUDIO', role: 'OUTPUT', metadata: { digitalHuman: { generationId: generation.id, provider: result.providerId, model: result.model, modelVersion: result.modelVersion } } });
    await deps.digitalHuman.completeSpeech(generation.id, { outputAssetId: asset.id, durationMs: result.durationMs, latencyMs: result.latencyMs, modelVersion: result.modelVersion, provenance: { ...result.provenance, provider: result.providerId, model: result.model, modelVersion: result.modelVersion, voiceProfileId: generation.voiceProfileId, referenceAssetId: voice.referenceAssetId, referenceChecksum: reference?.checksum || null, textHash: generation.textHash, parameters: generation.parameters, durationMs: result.durationMs, latencyMs: result.latencyMs } });
    return { generationId: generation.id, outputAssetId: asset.id, state: 'SUCCEEDED' };
  } catch (error) {
    if (signal.aborted) throw error;
    const providerError = error instanceof DigitalHumanProviderError ? error : null;
    await deps.digitalHuman.failSpeech(generation.id, { code: providerError?.code || 'SPEECH_GENERATION_FAILED', message: error instanceof Error ? error.message.slice(0, 200) : 'Speech generation failed' });
    throw error;
  }
}

async function processAvatar(job: JobRecord, attemptId: string, signal: AbortSignal, payload: ReturnType<typeof payloadOf>, deps: DigitalHumanWorkerDependencies): Promise<unknown> {
  const generation = await deps.digitalHuman.getAvatarGeneration(payload.projectId, payload.generationId); if (!generation) throw Object.assign(new Error('Avatar Generation not found'), { code: 'AVATAR_GENERATION_NOT_FOUND', retryable: false });
  if (generation.status === 'SUCCEEDED') return { generationId: generation.id, outputAssetId: generation.outputAssetId, state: generation.status };
  await deps.digitalHuman.markAvatarRunning(generation.id);
  const clip = await deps.digitalHuman.getAvatarClip(payload.projectId, generation.avatarClipId); const video = clip ? await deps.assets.getProjectAsset(payload.projectId, clip.assetId) : null; const audio = await deps.assets.getProjectAsset(payload.projectId, generation.speechAssetId);
  if (!clip || !video || video.kind !== 'VIDEO' || video.lifecycle !== 'READY') throw Object.assign(new Error('Avatar source video is not ready'), { code: 'AVATAR_CLIP_ASSET_NOT_READY', retryable: false });
  if (!audio || audio.kind !== 'AUDIO' || audio.lifecycle !== 'READY') throw Object.assign(new Error('Speech asset is not ready'), { code: 'SPEECH_ASSET_NOT_READY', retryable: false });
  signal.throwIfAborted();
  try {
    const existingTask = generation.externalTaskId ? await deps.avatarProvider.getTask(generation.externalTaskId) : null;
    const task = existingTask || await deps.avatarProvider.submitLipSync({ requestId: generation.id, projectId: payload.projectId, jobId: job.id, attemptId, correlationId: payload.correlationId, audioUrl: (await deps.staging.stageAsset(audio.id)).publicUrl, videoUrl: (await deps.staging.stageAsset(video.id)).publicUrl, ...(generation.model ? { model: generation.model } : {}), parameters: generation.provenance.parameters && typeof generation.provenance.parameters === 'object' ? generation.provenance.parameters as Record<string, unknown> : {} });
    if (!generation.externalTaskId) await deps.digitalHuman.markAvatarWaiting(generation.id, task.externalTaskId, { provider: task.providerId, externalTaskId: task.externalTaskId });
    if (task.status === 'QUEUED' || task.status === 'RUNNING') throw Object.assign(new Error('Avatar provider task is still running'), { code: 'EXTERNAL_TASK_PENDING', retryable: true });
    const taskError = task as { errorCode?: string; errorMessage?: string };
    if (task.status === 'FAILED' || task.status === 'CANCELLED' || !task.outputUrl) throw Object.assign(new Error(taskError.errorMessage || 'Avatar provider task failed'), { code: taskError.errorCode || 'AVATAR_PROVIDER_FAILED', retryable: false });
    signal.throwIfAborted();
    if (!/^https?:\/\//i.test(task.outputUrl)) throw Object.assign(new Error('Avatar provider returned an unsafe output URL'), { code: 'AVATAR_RESULT_URL_INVALID', retryable: false });
    const response = await fetch(task.outputUrl, { signal }); if (!response.ok) throw Object.assign(new Error('Unable to download avatar result'), { code: 'AVATAR_RESULT_DOWNLOAD_FAILED', retryable: response.status >= 500 });
    const bytes = Buffer.from(await response.arrayBuffer()); const tempPath = join(deps.storage.root, 'staging', `${generation.id}.avatar.mp4`); await mkdir(join(deps.storage.root, 'staging'), { recursive: true }); await writeFile(tempPath, bytes);
    try {
      const asset = await deps.assetService.importFile({ projectId: payload.projectId, sourcePath: tempPath, kind: 'VIDEO', role: 'OUTPUT', metadata: { digitalHuman: { generationId: generation.id, provider: task.providerId, externalTaskId: task.externalTaskId } } });
      const imported = await deps.assets.getReadySourceAsset(payload.projectId, asset.id, 'VIDEO'); const metadata = imported?.metadata || {};
      await deps.digitalHuman.completeAvatar(generation.id, { outputAssetId: asset.id, durationMs: typeof metadata.durationMs === 'number' ? metadata.durationMs : undefined, model: task.model, modelVersion: task.modelVersion, costAmount: task.costAmount, costCurrency: task.costCurrency, provenance: { provider: task.providerId, model: task.model || generation.model, modelVersion: task.modelVersion || null, avatarProfileId: generation.avatarProfileId, avatarClipId: generation.avatarClipId, speechAssetId: generation.speechAssetId, sourceVideoAssetId: video.id, externalTaskId: task.externalTaskId, costAmount: task.costAmount ?? null, costCurrency: task.costCurrency ?? null, ...(task.provenance || {}) } });
      return { generationId: generation.id, outputAssetId: asset.id, state: 'SUCCEEDED' };
    } finally { await rm(tempPath, { force: true }); }
  } catch (error) {
    if (signal.aborted || (error as { code?: unknown }).code === 'EXTERNAL_TASK_PENDING') throw error;
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
