import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobHandler } from '../../../shared/src/worker-runtime.js';
import type { PublishResult, PublisherAdapter, PublisherContext, PublisherCredential, PublisherPlatformId, PublishSnapshot } from '../../../contracts/src/index.js';
import type { CredentialProvider } from './credential-provider.js';

export interface ReviewApprovalProvider { isApproved(input: { projectId: string; targetType: 'PUBLISH'; targetId: string; reviewDecisionId: string }): Promise<boolean>; }
export interface PublisherJobPayload { platformId: PublisherPlatformId; accountId: string; credentialRef: string; projectId: string; targetId: string; reviewDecisionId: string; snapshot: PublishSnapshot; }
export interface PublisherHandlerOptions { registry: PublisherAdapterRegistry; approval: ReviewApprovalProvider; credentials: CredentialProvider; profileRoot: string; }

export class PublisherAdapterRegistry {
  private readonly adapters = new Map<PublisherPlatformId, PublisherAdapter>();
  register(adapter: PublisherAdapter): void {
    const platformId = adapter.capabilities().platformId;
    if (this.adapters.has(platformId)) throw new Error(`Publisher adapter ${platformId} already registered`);
    this.adapters.set(platformId, adapter);
  }
  get(platformId: PublisherPlatformId): PublisherAdapter {
    const adapter = this.adapters.get(platformId);
    if (!adapter) throw new Error(`Publisher adapter ${platformId} is not registered`);
    return adapter;
  }
  ids(): PublisherPlatformId[] { return [...this.adapters.keys()].sort(); }
}

export function createPublisherHandler(options: PublisherHandlerOptions): JobHandler {
  return async (rawPayload) => {
    const payload = rawPayload as PublisherJobPayload;
    const approved = await options.approval.isApproved({ projectId: payload.projectId, targetType: 'PUBLISH', targetId: payload.targetId, reviewDecisionId: payload.reviewDecisionId });
    if (!approved) return { status: 'FAILED', failure: { code: 'HUMAN_CONFIRMATION_REQUIRED', classification: 'HUMAN_ACTION_REQUIRED', message: 'An approved PUBLISH review decision is required' } } satisfies PublishResult;
    if (!/^[a-zA-Z0-9_-]+$/.test(payload.accountId)) return { status: 'FAILED', failure: { code: 'UNKNOWN', classification: 'TERMINAL', message: 'Invalid publisher account id' } } satisfies PublishResult;
    const adapter = options.registry.get(payload.platformId);
    const credential = await options.credentials.resolve(payload.credentialRef);
    const profileDir = join(options.profileRoot, payload.platformId, payload.accountId);
    await mkdir(profileDir, { recursive: true });
    const context: PublisherContext = { profileDir, credentialRef: payload.credentialRef, ...(Object.keys(credential).length ? { credential } : {}) };
    return adapter.publish(context, payload.snapshot);
  };
}

export type { PublisherCredential } from '../../../contracts/src/index.js';
