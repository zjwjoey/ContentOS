import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type {
  AlignmentProvider, AlignmentRequest, AvatarCapabilities, AvatarExternalTask, AvatarGenerationRequest, AvatarProvider, AvatarTaskStatus,
  ProviderMediaStaging, SpeechCapabilities, SpeechGenerationRequest, SpeechGenerationResult, SpeechProvider, SubtitleCue, SubtitleTimeline,
} from '../../../contracts/src/index.js';

export class DigitalHumanProviderError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'RATE_LIMITED' | 'AUTHENTICATION_FAILED' | 'INVALID_REQUEST' | 'EXTERNAL_FAILED', message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'DigitalHumanProviderError';
  }
}

function responseError(status: number): DigitalHumanProviderError {
  if (status === 401 || status === 403) return new DigitalHumanProviderError('AUTHENTICATION_FAILED', 'Digital human provider authentication failed', false);
  if (status === 429) return new DigitalHumanProviderError('RATE_LIMITED', 'Digital human provider rate limited the request', true);
  return new DigitalHumanProviderError(status >= 500 ? 'UNAVAILABLE' : 'INVALID_REQUEST', 'Digital human provider rejected the request', status >= 500);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const externalStatuses = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
function externalStatus(value: unknown, fallback: typeof externalStatuses[number] = 'QUEUED'): typeof externalStatuses[number] {
  return externalStatuses.includes(String(value) as typeof externalStatuses[number]) ? String(value) as typeof externalStatuses[number] : fallback;
}
function optionalNumber(value: unknown): number | undefined {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) ? result : undefined;
}

export interface IndexTTS25SpeechProviderOptions {
  baseUrl: string;
  modelVersion?: string;
  fetchImpl?: typeof fetch;
}

export class IndexTTS25SpeechProvider implements SpeechProvider {
  readonly providerId = 'indextts25';
  private readonly fetchImpl: typeof fetch;
  private readonly modelVersion: string;
  constructor(private readonly options: IndexTTS25SpeechProviderOptions) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.modelVersion = options.modelVersion || '2.5';
  }
  async getCapabilities(): Promise<SpeechCapabilities> {
    const response = await this.fetchImpl(new URL('/capabilities', this.options.baseUrl));
    if (!response.ok) throw responseError(response.status);
    const body = jsonObject(await response.json());
    const capabilities = jsonObject(body.capabilities);
    return {
      providerId: this.providerId, local: true,
      voiceClone: capabilities.voiceClone !== false, emotion: capabilities.emotion !== false, speed: capabilities.speed !== false,
      languages: Array.isArray(capabilities.languages) ? capabilities.languages.filter((value): value is string => typeof value === 'string') : ['zh'],
      supportsReferenceAudio: capabilities.supportsReferenceAudio !== false, requiresReferenceAudio: capabilities.requiresReferenceAudio === true, supportsVoiceId: capabilities.supportsVoiceId === true,
    };
  }
  async generateSpeech(request: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
    const started = Date.now();
    const response = await this.fetchImpl(new URL('/v1/speech/generate', this.options.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: request.requestId, referenceAudioPath: request.referenceAudioPath, providerVoiceId: request.providerVoiceId, text: request.text, language: request.language, speed: request.speed, emotion: request.emotion }),
    });
    if (!response.ok) throw responseError(response.status);
    const body = jsonObject(await response.json());
    if (body.status !== 'success' || typeof body.outputPath !== 'string') throw new DigitalHumanProviderError('EXTERNAL_FAILED', 'Speech gateway returned an invalid result', false);
    return {
      providerId: this.providerId, model: typeof body.model === 'string' ? body.model : 'indextts-2.5',
      modelVersion: typeof body.modelVersion === 'string' ? body.modelVersion : this.modelVersion,
      outputPath: body.outputPath, durationMs: Number(body.durationMs) || 0, latencyMs: Number(body.latencyMs) || Date.now() - started,
      provenance: { provider: this.providerId, modelVersion: typeof body.modelVersion === 'string' ? body.modelVersion : this.modelVersion },
    };
  }
}

export class FakeSpeechProvider implements SpeechProvider {
  readonly providerId = 'fake-speech';
  constructor(private readonly outputPath: string) {}
  async getCapabilities(): Promise<SpeechCapabilities> { return { providerId: this.providerId, local: true, voiceClone: true, emotion: true, speed: true, languages: ['zh', 'en'], supportsReferenceAudio: true, requiresReferenceAudio: false, supportsVoiceId: false }; }
  async generateSpeech(_request: SpeechGenerationRequest): Promise<SpeechGenerationResult> { return { providerId: this.providerId, model: 'fake-speech', modelVersion: '1', outputPath: this.outputPath, durationMs: 1_000, latencyMs: 1, provenance: { fake: true } }; }
}

export interface HttpAvatarProviderOptions {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  submitPath?: string;
  taskPath?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class HttpAvatarProvider implements AvatarProvider {
  readonly providerId: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: HttpAvatarProviderOptions) { this.providerId = options.providerId; this.fetchImpl = options.fetchImpl || fetch; }
  async getCapabilities(): Promise<AvatarCapabilities> { return { providerId: this.providerId, local: false, videoToVideo: true, imageToVideo: false, requiresPublicUrl: true, supportedFormats: ['mp4'] }; }
  async submitLipSync(request: AvatarGenerationRequest): Promise<AvatarExternalTask> {
    const response = await this.fetchImpl(new URL(this.options.submitPath || '/v1/lipsync/tasks', this.options.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({ audioUrl: request.audioUrl, videoUrl: request.videoUrl, model: request.model || this.options.model, parameters: request.parameters }),
    });
    if (!response.ok) throw responseError(response.status);
    const body = jsonObject(await response.json()); const taskId = typeof body.taskId === 'string' ? body.taskId : typeof body.id === 'string' ? body.id : '';
    if (!taskId) throw new DigitalHumanProviderError('EXTERNAL_FAILED', 'Avatar provider returned no task id', false);
    const costAmount = optionalNumber(body.costAmount); const provenance = jsonObject(body.provenance);
    return { externalTaskId: taskId, providerId: this.providerId, status: externalStatus(body.status), ...(typeof body.outputUrl === 'string' ? { outputUrl: body.outputUrl } : {}), ...(typeof body.model === 'string' ? { model: body.model } : {}), ...(typeof body.modelVersion === 'string' ? { modelVersion: body.modelVersion } : {}), ...(costAmount === undefined ? {} : { costAmount }), ...(typeof body.costCurrency === 'string' ? { costCurrency: body.costCurrency } : {}), ...(Object.keys(provenance).length ? { provenance } : {}) };
  }
  async getTask(externalTaskId: string): Promise<AvatarTaskStatus> {
    const path = (this.options.taskPath || '/v1/lipsync/tasks/:id').replace(':id', encodeURIComponent(externalTaskId));
    const response = await this.fetchImpl(new URL(path, this.options.baseUrl), { headers: { authorization: `Bearer ${this.options.apiKey}` } });
    if (!response.ok) throw responseError(response.status);
    const body = jsonObject(await response.json()); const status = body.status;
    if (!externalStatuses.includes(String(status) as typeof externalStatuses[number])) throw new DigitalHumanProviderError('EXTERNAL_FAILED', 'Avatar provider returned an invalid task status', false);
    const costAmount = optionalNumber(body.costAmount); const provenance = jsonObject(body.provenance);
    return { externalTaskId, providerId: this.providerId, status: status as AvatarTaskStatus['status'], ...(typeof body.outputUrl === 'string' ? { outputUrl: body.outputUrl } : {}), ...(typeof body.model === 'string' ? { model: body.model } : {}), ...(typeof body.modelVersion === 'string' ? { modelVersion: body.modelVersion } : {}), ...(costAmount === undefined ? {} : { costAmount }), ...(typeof body.costCurrency === 'string' ? { costCurrency: body.costCurrency } : {}), ...(Object.keys(provenance).length ? { provenance } : {}), ...(typeof body.errorCode === 'string' ? { errorCode: body.errorCode } : {}), ...(typeof body.errorMessage === 'string' ? { errorMessage: body.errorMessage } : {}) };
  }
  async cancelTask(externalTaskId: string): Promise<void> { const path = (this.options.taskPath || '/v1/lipsync/tasks/:id').replace(':id', encodeURIComponent(externalTaskId)); const response = await this.fetchImpl(new URL(path, this.options.baseUrl), { method: 'DELETE', headers: { authorization: `Bearer ${this.options.apiKey}` } }); if (!response.ok && response.status !== 404) throw responseError(response.status); }
}

/** HZAgent's vendor-specific boundary. Keep all HZAgent field/path choices here. */
export class HzAgentAvatarProvider extends HttpAvatarProvider {
  constructor(options: Omit<HttpAvatarProviderOptions, 'providerId'>) { super({ ...options, providerId: 'hzagent' }); }
}

export interface HttpProviderMediaStagingOptions { baseUrl: string; apiKey?: string; fetchImpl?: typeof fetch; }

export class HttpProviderMediaStaging implements ProviderMediaStaging {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: HttpProviderMediaStagingOptions) { this.fetchImpl = options.fetchImpl || fetch; }
  async stageAsset(assetId: string, options: { ttlSeconds?: number } = {}): Promise<{ publicUrl: string; expiresAt: string }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }; if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    const response = await this.fetchImpl(new URL('/v1/media/stage', this.options.baseUrl), { method: 'POST', headers, body: JSON.stringify({ assetId, ttlSeconds: options.ttlSeconds || 900 }) });
    if (!response.ok) throw responseError(response.status);
    const body = jsonObject(await response.json());
    if (typeof body.publicUrl !== 'string' || !/^https?:\/\//.test(body.publicUrl) || typeof body.expiresAt !== 'string') throw new DigitalHumanProviderError('EXTERNAL_FAILED', 'Media staging service returned an invalid result', false);
    return { publicUrl: body.publicUrl, expiresAt: body.expiresAt };
  }
}

export class FakeAvatarProvider implements AvatarProvider {
  readonly providerId = 'fake-avatar';
  private readonly tasks = new Map<string, AvatarTaskStatus>();
  async getCapabilities(): Promise<AvatarCapabilities> { return { providerId: this.providerId, local: true, videoToVideo: true, imageToVideo: false, requiresPublicUrl: false, supportedFormats: ['mp4'] }; }
  async submitLipSync(_request: AvatarGenerationRequest): Promise<AvatarExternalTask> { const externalTaskId = `fake-${randomUUID()}`; const task: AvatarTaskStatus = { externalTaskId, providerId: this.providerId, status: 'SUCCEEDED', outputUrl: 'https://example.invalid/fake-avatar.mp4' }; this.tasks.set(externalTaskId, task); return task; }
  async getTask(externalTaskId: string): Promise<AvatarTaskStatus> { const task = this.tasks.get(externalTaskId); if (!task) throw new DigitalHumanProviderError('EXTERNAL_FAILED', 'Fake avatar task not found', false); return task; }
  async cancelTask(externalTaskId: string): Promise<void> { this.tasks.set(externalTaskId, { externalTaskId, providerId: this.providerId, status: 'CANCELLED' }); }
}

export class SyntheticTimingProvider implements AlignmentProvider {
  readonly providerId = 'synthetic-timing';
  async align(request: AlignmentRequest): Promise<SubtitleTimeline> {
    const sentences = request.text.split(/(?<=[。！？!?；;])\s*|\n+/).map((value) => value.trim()).filter(Boolean);
    const values = sentences.length > 0 ? sentences : [request.text.trim()];
    const weights = values.map((value) => Math.max(1, [...value].length)); const total = weights.reduce((sum, value) => sum + value, 0) || 1;
    let cursor = 0;
    const cues: SubtitleCue[] = values.map((text, index) => { const duration = index === values.length - 1 ? request.durationMs - cursor : Math.max(1, Math.round(request.durationMs * (weights[index] || 1) / total)); const cue = { index: index + 1, text, startMs: cursor, endMs: cursor + duration }; cursor += duration; return cue; });
    return { providerId: this.providerId, cues, durationMs: request.durationMs };
  }
}

export function basenameForGeneratedAsset(path: string, fallback: string): string { const name = basename(path).trim(); return name || fallback; }
