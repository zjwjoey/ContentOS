import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AuthResult, ExternalStateResult, PlatformCapabilityProfile, PublishResult, PublishSnapshot, PublisherAdapter, PublisherContext, PublisherFailure, PublisherPlatformId } from '../../../contracts/src/index.js';
import { FetchDouyinHttpTransport, type DouyinHttpTransport } from './douyin-http.js';

export interface PublishStateStore { get(idempotencyKey: string): Promise<string | null>; set(idempotencyKey: string, externalPostId: string): Promise<void>; }
export class InMemoryPublishStateStore implements PublishStateStore {
  private readonly values = new Map<string, string>();
  async get(idempotencyKey: string): Promise<string | null> { return this.values.get(idempotencyKey) || null; }
  async set(idempotencyKey: string, externalPostId: string): Promise<void> { this.values.set(idempotencyKey, externalPostId); }
}
export interface DouyinEndpointProfile { baseUrl: string; uploadPath: string; createPath: string; listPath: string; }
const defaultEndpoints: DouyinEndpointProfile = { baseUrl: 'https://open.douyin.com', uploadPath: '/video/upload/', createPath: '/api/douyin/v1/video/create_video/', listPath: '/video/list/' };
type DouyinPayload = { data?: { error_code?: number; description?: string; video?: { video_id?: string }; item_id?: string }; extra?: { error_code?: number; description?: string } };

function failure(code: PublisherFailure['code'], classification: PublisherFailure['classification'], message: string): PublisherFailure { return { code, classification, message }; }
function codeOf(payload: DouyinPayload): number { return Number(payload.data?.error_code || payload.extra?.error_code || 0); }

export class DouyinOpenApiAdapter implements PublisherAdapter {
  private readonly transport: DouyinHttpTransport;
  private readonly state: PublishStateStore;
  private readonly endpoints: DouyinEndpointProfile;
  constructor(transport: DouyinHttpTransport = new FetchDouyinHttpTransport(), state: PublishStateStore = new InMemoryPublishStateStore(), endpoints: Partial<DouyinEndpointProfile> = {}) {
    this.transport = transport; this.state = state; this.endpoints = { ...defaultEndpoints, ...endpoints };
  }
  capabilities(): PlatformCapabilityProfile { return { platformId: 'douyin', mediaTypes: ['video/mp4', 'video/webm'], scheduling: false, requiresHumanConfirmation: true }; }
  async authenticate(context: PublisherContext): Promise<AuthResult> {
    if (!context.credential?.accessToken || !context.credential.openId) return { status: 'FAILED', failure: failure('AUTH_EXPIRED', 'HUMAN_ACTION_REQUIRED', 'Douyin access authorization is required') };
    return { status: 'AUTHENTICATED' };
  }
  async publish(context: PublisherContext, snapshot: PublishSnapshot): Promise<PublishResult> {
    const existing = await this.state.get(snapshot.idempotencyKey);
    if (existing) return { status: 'PUBLISHED', externalPostId: existing };
    const auth = await this.authenticate(context);
    if (auth.status === 'FAILED') return { status: 'FAILED', ...(auth.failure ? { failure: auth.failure } : {}) };
    if (!snapshot.mediaPath) return { status: 'FAILED', failure: failure('UPLOAD_FAILED', 'PERMANENT', 'Douyin mediaPath is required') };
    let videoId: string;
    try {
      const media = await readFile(snapshot.mediaPath);
      const form = new FormData();
      form.set('video', new Blob([media], { type: 'video/mp4' }), basename(snapshot.mediaPath));
      const upload = await this.transport.request({ method: 'POST', url: `${this.endpoints.baseUrl}${this.endpoints.uploadPath}`, headers: { 'access-token': context.credential?.accessToken || '' }, body: form });
      const uploadPayload = await this.readPayload(upload);
      if (!upload.ok || codeOf(uploadPayload) !== 0 || !uploadPayload.data?.video?.video_id) return { status: 'FAILED', failure: this.mapFailure(codeOf(uploadPayload), 'upload') };
      videoId = uploadPayload.data.video.video_id;
    } catch (error) {
      const message = error instanceof Error && error.message === 'ENOENT' ? 'Douyin media file was not found' : 'Douyin upload transport failed';
      return { status: 'FAILED', failure: failure('UPLOAD_FAILED', 'PERMANENT', message) };
    }
    try {
      const text = [snapshot.title.trim(), snapshot.description.trim()].filter(Boolean).join('\n');
      const url = new URL(`${this.endpoints.baseUrl}${this.endpoints.createPath}`);
      url.searchParams.set('open_id', context.credential?.openId || '');
      const create = await this.transport.request({ method: 'POST', url: url.toString(), headers: { 'access-token': context.credential?.accessToken || '', 'content-type': 'application/json' }, body: JSON.stringify({ video_id: videoId, text }) });
      const createPayload = await this.readPayload(create);
      if (!create.ok || codeOf(createPayload) !== 0 || !createPayload.data?.item_id) return { status: 'FAILED', failure: this.mapFailure(codeOf(createPayload), 'create') };
      await this.state.set(snapshot.idempotencyKey, createPayload.data.item_id);
      return { status: 'PUBLISHED', externalPostId: createPayload.data.item_id };
    } catch {
      return { status: 'UNKNOWN_EXTERNAL_STATE', failure: failure('UNKNOWN_EXTERNAL_STATE', 'RECONCILIATION_REQUIRED', 'Douyin create request ended without a confirmed result') };
    }
  }
  async reconcile(_context: PublisherContext, idempotencyKey: string): Promise<ExternalStateResult> {
    const externalPostId = await this.state.get(idempotencyKey);
    return externalPostId ? { status: 'PUBLISHED', externalPostId } : { status: 'UNKNOWN' };
  }
  private async readPayload(response: Response): Promise<DouyinPayload> {
    try { return await response.json() as DouyinPayload; } catch { return {}; }
  }
  private mapFailure(errorCode: number, stage: 'upload' | 'create'): PublisherFailure {
    if ([28001003, 28001008].includes(errorCode)) return failure('AUTH_EXPIRED', 'HUMAN_ACTION_REQUIRED', 'Douyin authorization expired');
    if ([2114007, 28003017].includes(errorCode)) return failure('RATE_LIMIT', 'RETRYABLE', 'Douyin publish quota is unavailable');
    if ([2100004, 28001006].includes(errorCode)) return failure('NETWORK_ERROR', 'RETRYABLE', 'Douyin service is temporarily unavailable');
    if (stage === 'upload') return failure('UPLOAD_FAILED', 'PERMANENT', 'Douyin rejected the uploaded media');
    return failure(errorCode ? 'UNKNOWN' : 'UNKNOWN_EXTERNAL_STATE', errorCode ? 'TERMINAL' : 'RECONCILIATION_REQUIRED', 'Douyin did not confirm video creation');
  }
}

export type { DouyinHttpTransport } from './douyin-http.js';
