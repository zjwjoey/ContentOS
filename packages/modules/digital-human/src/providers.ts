import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
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

const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CAPABILITY_TIMEOUT_MS = 5_000;

function timeoutMs(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function providerFetch(fetchImpl: typeof fetch, input: RequestInfo | URL, init: RequestInit, requestTimeoutMs: number): Promise<Response> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try { return await fetchImpl(input, { ...init, signal: controller.signal }); }
  catch (error) { if (controller.signal.aborted) throw new DigitalHumanProviderError('UNAVAILABLE', 'Digital human provider request timed out', true); throw new DigitalHumanProviderError('UNAVAILABLE', error instanceof Error ? error.message.slice(0, 200) : 'Digital human provider request failed', true); }
  finally { clearTimeout(timer); }
}

function responseError(status: number): DigitalHumanProviderError {
  if (status === 401 || status === 403) return new DigitalHumanProviderError('AUTHENTICATION_FAILED', 'Digital human provider authentication failed', false);
  if (status === 429) return new DigitalHumanProviderError('RATE_LIMITED', 'Digital human provider rate limited the request', true);
  return new DigitalHumanProviderError(status >= 500 ? 'UNAVAILABLE' : 'INVALID_REQUEST', 'Digital human provider rejected the request', status >= 500);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalNumber(value: unknown): number | undefined {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) ? result : undefined;
}

export function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value); if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''); if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    const ipVersion = isIP(hostname);
    if (ipVersion === 4) { const octets = hostname.split('.').map(Number); const first = octets[0] ?? -1; const second = octets[1] ?? -1; if (first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || first === 0) return false; }
    if (ipVersion === 6 && (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe8') || hostname.startsWith('fe9') || hostname.startsWith('fea') || hostname.startsWith('feb'))) return false;
    return true;
  } catch { return false; }
}

export interface SpeechCapabilityRequest {
  text: string;
  language: string;
  speed: number;
  emotion: string;
  hasReferenceAudio: boolean;
  hasProviderVoiceId: boolean;
}

export interface SpeechCapabilityError {
  code: 'VOICE_REFERENCE_REQUIRED' | 'VOICE_REFERENCE_UNSUPPORTED' | 'PROVIDER_VOICE_ID_UNSUPPORTED' | 'SPEECH_LANGUAGE_UNSUPPORTED' | 'SPEECH_SPEED_UNSUPPORTED' | 'SPEECH_EMOTION_UNSUPPORTED' | 'SPEECH_TEXT_TOO_LONG';
  message: string;
}

export function speechCapabilityError(capabilities: SpeechCapabilities, request: SpeechCapabilityRequest): SpeechCapabilityError | null {
  if (capabilities.requiresReferenceAudio && !request.hasReferenceAudio) return { code: 'VOICE_REFERENCE_REQUIRED', message: 'This speech provider requires a ready reference audio Asset' };
  if (request.hasReferenceAudio && !capabilities.supportsReferenceAudio) return { code: 'VOICE_REFERENCE_UNSUPPORTED', message: 'This speech provider does not support reference audio' };
  if (request.hasProviderVoiceId && !capabilities.supportsVoiceId) return { code: 'PROVIDER_VOICE_ID_UNSUPPORTED', message: 'This speech provider does not support provider voice IDs' };
  if (capabilities.languages.length > 0 && !capabilities.languages.includes(request.language)) return { code: 'SPEECH_LANGUAGE_UNSUPPORTED', message: `This speech provider does not support ${request.language}` };
  if (!capabilities.speed && request.speed !== 1) return { code: 'SPEECH_SPEED_UNSUPPORTED', message: 'This speech provider does not support custom speed' };
  if ((capabilities.minSpeed !== undefined && request.speed < capabilities.minSpeed) || (capabilities.maxSpeed !== undefined && request.speed > capabilities.maxSpeed)) return { code: 'SPEECH_SPEED_UNSUPPORTED', message: `This speech provider supports speed from ${capabilities.minSpeed ?? 0.5} to ${capabilities.maxSpeed ?? 2}` };
  if (!capabilities.emotion && !['natural', 'neutral'].includes(request.emotion.trim().toLowerCase())) return { code: 'SPEECH_EMOTION_UNSUPPORTED', message: 'This speech provider does not support custom emotion' };
  if (capabilities.maxTextCharacters !== undefined && request.text.length > capabilities.maxTextCharacters) return { code: 'SPEECH_TEXT_TOO_LONG', message: `Speech text exceeds the provider limit of ${capabilities.maxTextCharacters} characters` };
  return null;
}

export interface IndexTTS25SpeechProviderOptions {
  baseUrl: string;
  modelVersion?: string;
  requestTimeoutMs?: number;
  capabilityTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface HzAgentAvatarProviderOptions {
  baseUrl?: string;
  apiKey: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function hzAgentTaskId(body: Record<string, unknown>): string | undefined {
  const data = jsonObject(body.data);
  const candidate = typeof body.data === 'string' ? body.data : data.id ?? data.task_id ?? data.taskId;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function hzAgentTaskData(body: Record<string, unknown>): Record<string, unknown> {
  return jsonObject(body.data);
}

function hzAgentStatus(value: unknown, outputUrl: string | undefined): AvatarTaskStatus['status'] {
  if (outputUrl) return 'SUCCEEDED';
  const normalized = typeof value === 'string' ? value.toLowerCase() : value;
  if (normalized === 2 || normalized === '2' || normalized === 'success' || normalized === 'succeeded' || normalized === 'completed' || normalized === 'complete') return 'SUCCEEDED';
  if (normalized === 3 || normalized === '3' || normalized === 'failed' || normalized === 'error') return 'FAILED';
  if (normalized === 4 || normalized === '4' || normalized === 'cancelled' || normalized === 'canceled') return 'CANCELLED';
  return 'RUNNING';
}

/** HZAgent's documented asynchronous video-to-video lip-sync API. */
export class HzAgentAvatarProvider implements AvatarProvider {
  readonly providerId = 'hzagent';
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: HzAgentAvatarProviderOptions) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.baseUrl = options.baseUrl || 'https://api.ai.hzagent.cn';
    this.requestTimeoutMs = timeoutMs(options.requestTimeoutMs, 30_000);
  }

  async getCapabilities(): Promise<AvatarCapabilities> {
    if (!this.options.apiKey.trim()) throw new DigitalHumanProviderError('AUTHENTICATION_FAILED', 'HZAgent API key is not configured', false);
    return { providerId: this.providerId, local: false, videoToVideo: true, imageToVideo: false, requiresPublicUrl: true, supportedFormats: ['mp4', 'mov', 'webm'], supportedAudioFormats: ['mp3', 'wav', 'm4a', 'aac', 'ogg'] };
  }

  async submitLipSync(request: AvatarGenerationRequest): Promise<AvatarExternalTask> {
    const response = await providerFetch(this.fetchImpl, new URL('/v1/avatar-lipsync/generations', this.baseUrl), {
      method: 'POST', headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ videoName: String(request.parameters.videoName || request.requestId), audioUrl: request.audioUrl, videoUrl: request.videoUrl }),
    }, this.requestTimeoutMs);
    const body = jsonObject(await response.json().catch(() => ({})));
    if (!response.ok || (body.code !== undefined && Number(body.code) !== 200)) {
      const message = typeof body.msg === 'string' && body.msg.trim() ? `HZAgent rejected the request: ${body.msg.trim()}` : 'HZAgent rejected the request';
      throw new DigitalHumanProviderError(response.status >= 500 ? 'UNAVAILABLE' : 'INVALID_REQUEST', message, response.status >= 500);
    }
    const externalTaskId = hzAgentTaskId(body);
    if (!externalTaskId) throw new DigitalHumanProviderError('EXTERNAL_FAILED', 'HZAgent did not return a task ID', false);
    return { externalTaskId, providerId: this.providerId, status: 'QUEUED', provenance: { provider: this.providerId, requestId: request.requestId } };
  }

  async getTask(externalTaskId: string): Promise<AvatarTaskStatus> {
    const response = await providerFetch(this.fetchImpl, new URL(`/v1/avatar-lipsync/tasks/${encodeURIComponent(externalTaskId)}`, this.baseUrl), { headers: { authorization: `Bearer ${this.options.apiKey}` } }, this.requestTimeoutMs);
    const body = jsonObject(await response.json().catch(() => ({})));
    if (!response.ok || (body.code !== undefined && Number(body.code) !== 200)) {
      const message = typeof body.msg === 'string' && body.msg.trim() ? `HZAgent task query rejected: ${body.msg.trim()}` : 'HZAgent task query rejected';
      throw new DigitalHumanProviderError(response.status >= 500 ? 'UNAVAILABLE' : 'INVALID_REQUEST', message, response.status >= 500);
    }
    const data = hzAgentTaskData(body);
    const result = Array.isArray(data.result) ? data.result : [];
    const outputUrl = result.find((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value));
    const status = hzAgentStatus(data.status, outputUrl);
    return { externalTaskId: String(data.task_id || data.taskId || externalTaskId), providerId: this.providerId, status, ...(outputUrl ? { outputUrl } : {}), ...(status === 'FAILED' ? { errorCode: 'HZAGENT_TASK_FAILED', errorMessage: String(data.message || body.msg || 'HZAgent task failed') } : {}), provenance: { provider: this.providerId, rawStatus: data.status } };
  }
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
    const response = await providerFetch(this.fetchImpl, new URL('/capabilities', this.options.baseUrl), {}, timeoutMs(this.options.capabilityTimeoutMs, DEFAULT_CAPABILITY_TIMEOUT_MS));
    if (!response.ok) throw responseError(response.status);
    const body = jsonObject(await response.json());
    const capabilities = jsonObject(body.capabilities);
    const maxTextCharacters = optionalNumber(capabilities.maxTextCharacters ?? capabilities.max_text_characters);
    return {
      providerId: this.providerId, local: true,
      voiceClone: capabilities.voiceClone !== false, emotion: capabilities.emotion !== false, speed: capabilities.speed !== false,
      minSpeed: 0.5, maxSpeed: 2,
      languages: Array.isArray(capabilities.languages) ? capabilities.languages.filter((value): value is string => typeof value === 'string') : ['zh'],
      supportsReferenceAudio: capabilities.supportsReferenceAudio !== false, requiresReferenceAudio: capabilities.requiresReferenceAudio === true, supportsVoiceId: capabilities.supportsVoiceId === true,
      ...(maxTextCharacters === undefined ? {} : { maxTextCharacters }),
    };
  }
  async generateSpeech(request: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
    const started = Date.now();
    const response = await providerFetch(this.fetchImpl, new URL('/v1/speech/generate', this.options.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: request.requestId, referenceAudioPath: request.referenceAudioPath, providerVoiceId: request.providerVoiceId, text: request.text, language: request.language, speed: request.speed, emotion: request.emotion }),
    }, timeoutMs(this.options.requestTimeoutMs, DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS));
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
  async getCapabilities(): Promise<SpeechCapabilities> { return { providerId: this.providerId, local: true, voiceClone: true, emotion: true, speed: true, minSpeed: 0.5, maxSpeed: 2, languages: ['zh', 'en'], supportsReferenceAudio: true, requiresReferenceAudio: false, supportsVoiceId: false, maxTextCharacters: 20_000 }; }
  async generateSpeech(_request: SpeechGenerationRequest): Promise<SpeechGenerationResult> { return { providerId: this.providerId, model: 'fake-speech', modelVersion: '1', outputPath: this.outputPath, durationMs: 1_000, latencyMs: 1, provenance: { fake: true } }; }
}

export interface SignedProviderMediaStagingOptions { baseUrl: string; secret: string; }

function base64UrlEncode(value: string): string { return Buffer.from(value, 'utf8').toString('base64url'); }
function base64UrlDecode(value: string): string { return Buffer.from(value, 'base64url').toString('utf8'); }
function providerMediaSignature(payload: string, secret: string): string { return createHmac('sha256', secret).update(payload).digest('base64url'); }

export function createProviderMediaToken(projectId: string, assetId: string, expiresAtSeconds: number, secret: string): string {
  if (!projectId.trim() || !assetId.trim() || !Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= Math.floor(Date.now() / 1000) || !secret.trim()) throw new Error('Invalid provider media token input');
  const payload = base64UrlEncode(JSON.stringify({ projectId, assetId, expiresAtSeconds }));
  return `${payload}.${providerMediaSignature(payload, secret)}`;
}

export function verifyProviderMediaToken(token: string, secret: string): { projectId: string; assetId: string; expiresAtSeconds: number } | null {
  if (!token || !secret.trim()) return null;
  const separator = token.lastIndexOf('.'); if (separator <= 0 || separator === token.length - 1) return null;
  const payload = token.slice(0, separator); const signature = token.slice(separator + 1); const expected = providerMediaSignature(payload, secret);
  const actualBytes = Buffer.from(signature); const expectedBytes = Buffer.from(expected); if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const value = JSON.parse(base64UrlDecode(payload)) as { projectId?: unknown; assetId?: unknown; expiresAtSeconds?: unknown }; const expiresAtSeconds = value.expiresAtSeconds;
    if (typeof value.projectId !== 'string' || !value.projectId.trim() || typeof value.assetId !== 'string' || !value.assetId.trim() || typeof expiresAtSeconds !== 'number' || !Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= Math.floor(Date.now() / 1000)) return null;
    return { projectId: value.projectId, assetId: value.assetId, expiresAtSeconds };
  } catch { return null; }
}

export class SignedProviderMediaStaging implements ProviderMediaStaging {
  constructor(private readonly options: SignedProviderMediaStagingOptions) {}
  async stageAsset(assetId: string, options: { ttlSeconds?: number; projectId?: string; extension?: string } = {}): Promise<{ publicUrl: string; expiresAt: string }> {
    if (!isPublicHttpUrl(this.options.baseUrl)) throw new DigitalHumanProviderError('UNAVAILABLE', 'Provider media staging base URL is not public', false);
    if (!options.projectId?.trim()) throw new DigitalHumanProviderError('INVALID_REQUEST', 'Provider media staging requires a project binding', false);
    const ttlSeconds = Math.min(3600, Math.max(60, Math.floor(options.ttlSeconds || 900))); const expiresAtSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;
    const token = createProviderMediaToken(options.projectId, assetId, expiresAtSeconds, this.options.secret); const extension = options.extension?.trim().replace(/[^a-z0-9]/gi, '').toLowerCase(); const publicUrl = new URL(`/api/v1/provider-media${extension ? `.${extension}` : ''}`, this.options.baseUrl); publicUrl.searchParams.set('token', token);
    return { publicUrl: publicUrl.toString(), expiresAt: new Date(expiresAtSeconds * 1000).toISOString() };
  }
}

export class FakeAvatarProvider implements AvatarProvider {
  readonly providerId = 'fake-avatar';
  private readonly tasks = new Map<string, AvatarTaskStatus>();
  private readonly requestTasks = new Map<string, AvatarTaskStatus>();
  constructor(private readonly outputUrl = 'https://example.invalid/fake-avatar.mp4') {}
  async getCapabilities(): Promise<AvatarCapabilities> { return { providerId: this.providerId, local: true, videoToVideo: true, imageToVideo: false, requiresPublicUrl: false, supportedFormats: ['mp4'] }; }
  async submitLipSync(request: AvatarGenerationRequest): Promise<AvatarExternalTask> { const existing = this.requestTasks.get(request.requestId); if (existing) return existing; const externalTaskId = `fake-${randomUUID()}`; const task: AvatarTaskStatus = { externalTaskId, providerId: this.providerId, status: 'SUCCEEDED', outputUrl: this.outputUrl, provenance: { fake: true, requestId: request.requestId } }; this.tasks.set(externalTaskId, task); this.requestTasks.set(request.requestId, task); return task; }
  async getTask(externalTaskId: string): Promise<AvatarTaskStatus> { const task = this.tasks.get(externalTaskId); if (!task) throw new DigitalHumanProviderError('EXTERNAL_FAILED', 'Fake avatar task not found', false); return task; }
  async cancelTask(externalTaskId: string): Promise<void> { const task = await this.getTask(externalTaskId); if (task.status === 'QUEUED' || task.status === 'RUNNING') this.tasks.set(externalTaskId, { ...task, status: 'CANCELLED' }); }
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
