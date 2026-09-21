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
  async getCapabilities(): Promise<SpeechCapabilities> { return { providerId: this.providerId, local: true, voiceClone: true, emotion: true, speed: true, languages: ['zh', 'en'], supportsReferenceAudio: true, requiresReferenceAudio: false, supportsVoiceId: false, maxTextCharacters: 20_000 }; }
  async generateSpeech(_request: SpeechGenerationRequest): Promise<SpeechGenerationResult> { return { providerId: this.providerId, model: 'fake-speech', modelVersion: '1', outputPath: this.outputPath, durationMs: 1_000, latencyMs: 1, provenance: { fake: true } }; }
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
    if (!isPublicHttpUrl(this.options.baseUrl)) throw new DigitalHumanProviderError('UNAVAILABLE', 'Provider media staging base URL is not public', false);
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
