import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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
  const normalized = String(value || '').toUpperCase(); return externalStatuses.includes(normalized as typeof externalStatuses[number]) ? normalized as typeof externalStatuses[number] : normalized === 'COMPLETED' ? 'SUCCEEDED' : fallback;
}
function optionalNumber(value: unknown): number | undefined {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) ? result : undefined;
}
function optionalString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function firstString(body: Record<string, unknown>, ...keys: string[]): string | undefined { for (const key of keys) { const value = optionalString(body[key]); if (value) return value; } return undefined; }

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
  authHeaderName?: string;
  authScheme?: string;
  idempotencyHeaderName?: string;
  fetchImpl?: typeof fetch;
}

export class HttpAvatarProvider implements AvatarProvider {
  readonly providerId: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: HttpAvatarProviderOptions) { this.providerId = options.providerId; this.fetchImpl = options.fetchImpl || fetch; }
  private authHeaders(): Record<string, string> { const name = this.options.authHeaderName || 'authorization'; const value = this.options.authScheme === '' ? this.options.apiKey : `${this.options.authScheme || 'Bearer'} ${this.options.apiKey}`; return { [name]: value }; }
  async getCapabilities(): Promise<AvatarCapabilities> { return { providerId: this.providerId, local: false, videoToVideo: true, imageToVideo: false, requiresPublicUrl: true, supportedFormats: ['mp4'] }; }
  async submitLipSync(request: AvatarGenerationRequest): Promise<AvatarExternalTask> {
    const idempotencyHeaderName = this.options.idempotencyHeaderName === '' ? '' : (this.options.idempotencyHeaderName || 'Idempotency-Key');
    const response = await this.fetchImpl(new URL(this.options.submitPath || '/v1/lipsync/tasks', this.options.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', ...this.authHeaders(), ...(idempotencyHeaderName ? { [idempotencyHeaderName]: request.requestId } : {}) },
      body: JSON.stringify({ requestId: request.requestId, projectId: request.projectId, jobId: request.jobId, correlationId: request.correlationId, audioUrl: request.audioUrl, videoUrl: request.videoUrl, model: request.model || this.options.model, parameters: request.parameters }),
    });
    if (!response.ok) throw responseError(response.status);
    const body = jsonObject(await response.json()); const taskId = firstString(body, 'taskId', 'task_id', 'id') || '';
    if (!taskId) throw new DigitalHumanProviderError('EXTERNAL_FAILED', 'Avatar provider returned no task id', false);
    const costAmount = optionalNumber(body.costAmount ?? body.cost_amount); const provenance = jsonObject(body.provenance); const outputUrl = firstString(body, 'outputUrl', 'output_url', 'resultUrl', 'result_url', 'videoUrl', 'video_url'); const model = firstString(body, 'model'); const modelVersion = firstString(body, 'modelVersion', 'model_version'); const costCurrency = firstString(body, 'costCurrency', 'cost_currency');
    return { externalTaskId: taskId, providerId: this.providerId, status: externalStatus(body.status ?? body.state), ...(outputUrl ? { outputUrl } : {}), ...(model ? { model } : {}), ...(modelVersion ? { modelVersion } : {}), ...(costAmount === undefined ? {} : { costAmount }), ...(costCurrency ? { costCurrency } : {}), ...(Object.keys(provenance).length ? { provenance } : {}) };
  }
  async getTask(externalTaskId: string): Promise<AvatarTaskStatus> {
    const path = (this.options.taskPath || '/v1/lipsync/tasks/:id').replace(':id', encodeURIComponent(externalTaskId));
    const response = await this.fetchImpl(new URL(path, this.options.baseUrl), { headers: this.authHeaders() });
    if (!response.ok) throw responseError(response.status);
    const body = jsonObject(await response.json()); const rawStatus = String(body.status ?? body.state ?? '').toUpperCase();
    if (!externalStatuses.includes(rawStatus as typeof externalStatuses[number]) && rawStatus !== 'COMPLETED') throw new DigitalHumanProviderError('EXTERNAL_FAILED', 'Avatar provider returned an invalid task status', false);
    const costAmount = optionalNumber(body.costAmount ?? body.cost_amount); const provenance = jsonObject(body.provenance); const outputUrl = firstString(body, 'outputUrl', 'output_url', 'resultUrl', 'result_url', 'videoUrl', 'video_url'); const model = firstString(body, 'model'); const modelVersion = firstString(body, 'modelVersion', 'model_version'); const costCurrency = firstString(body, 'costCurrency', 'cost_currency'); const errorCode = firstString(body, 'errorCode', 'error_code'); const errorMessage = firstString(body, 'errorMessage', 'error_message');
    return { externalTaskId, providerId: this.providerId, status: rawStatus === 'COMPLETED' ? 'SUCCEEDED' : rawStatus as AvatarTaskStatus['status'], ...(outputUrl ? { outputUrl } : {}), ...(model ? { model } : {}), ...(modelVersion ? { modelVersion } : {}), ...(costAmount === undefined ? {} : { costAmount }), ...(costCurrency ? { costCurrency } : {}), ...(Object.keys(provenance).length ? { provenance } : {}), ...(errorCode ? { errorCode } : {}), ...(errorMessage ? { errorMessage } : {}) };
  }
  async cancelTask(externalTaskId: string): Promise<void> { const path = (this.options.taskPath || '/v1/lipsync/tasks/:id').replace(':id', encodeURIComponent(externalTaskId)); const response = await this.fetchImpl(new URL(path, this.options.baseUrl), { method: 'DELETE', headers: this.authHeaders() }); if (!response.ok && response.status !== 404) throw responseError(response.status); }
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

export interface SignedProviderMediaStagingOptions { baseUrl: string; secret: string; }

function base64UrlEncode(value: string): string { return Buffer.from(value, 'utf8').toString('base64url'); }
function base64UrlDecode(value: string): string { return Buffer.from(value, 'base64url').toString('utf8'); }
function providerMediaSignature(payload: string, secret: string): string { return createHmac('sha256', secret).update(payload).digest('base64url'); }

export function createProviderMediaToken(assetId: string, expiresAtSeconds: number, secret: string): string {
  if (!assetId.trim() || !Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= Math.floor(Date.now() / 1000) || !secret.trim()) throw new Error('Invalid provider media token input');
  const payload = base64UrlEncode(JSON.stringify({ assetId, expiresAtSeconds }));
  return `${payload}.${providerMediaSignature(payload, secret)}`;
}

export function verifyProviderMediaToken(token: string, secret: string): { assetId: string; expiresAtSeconds: number } | null {
  if (!token || !secret.trim()) return null;
  const separator = token.lastIndexOf('.'); if (separator <= 0 || separator === token.length - 1) return null;
  const payload = token.slice(0, separator); const signature = token.slice(separator + 1); const expected = providerMediaSignature(payload, secret);
  const actualBytes = Buffer.from(signature); const expectedBytes = Buffer.from(expected); if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const value = JSON.parse(base64UrlDecode(payload)) as { assetId?: unknown; expiresAtSeconds?: unknown }; const expiresAtSeconds = value.expiresAtSeconds;
    if (typeof value.assetId !== 'string' || !value.assetId.trim() || typeof expiresAtSeconds !== 'number' || !Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= Math.floor(Date.now() / 1000)) return null;
    return { assetId: value.assetId, expiresAtSeconds };
  } catch { return null; }
}

export class SignedProviderMediaStaging implements ProviderMediaStaging {
  constructor(private readonly options: SignedProviderMediaStagingOptions) {}
  async stageAsset(assetId: string, options: { ttlSeconds?: number } = {}): Promise<{ publicUrl: string; expiresAt: string }> {
    const ttlSeconds = Math.min(3600, Math.max(60, Math.floor(options.ttlSeconds || 900))); const expiresAtSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;
    const token = createProviderMediaToken(assetId, expiresAtSeconds, this.options.secret); const publicUrl = new URL('/api/v1/provider-media', this.options.baseUrl); publicUrl.searchParams.set('token', token);
    return { publicUrl: publicUrl.toString(), expiresAt: new Date(expiresAtSeconds * 1000).toISOString() };
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
