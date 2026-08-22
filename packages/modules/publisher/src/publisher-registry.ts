import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobHandler } from '../../../shared/src/worker-runtime.js';
import { createPublishSnapshotDigest, type PublishResult, type PublisherAdapter, type PublisherContext, type PublisherCredential, type PublisherPlatformId, type PublishSnapshot } from '../../../contracts/src/index.js';
import type { CredentialProvider } from './credential-provider.js';

export interface ReviewApprovalProvider { isApproved(input: { projectId: string; targetType: 'PUBLISH'; targetId: string; reviewDecisionId: string; snapshotDigest: string }): Promise<boolean>; }
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
    if (!/^[a-zA-Z0-9_-]+$/.test(payload.accountId)) return { status: 'FAILED', failure: { code: 'UNKNOWN', classification: 'TERMINAL', message: 'Invalid publisher account id' } } satisfies PublishResult;
    const adapter = options.registry.get(payload.platformId);
    const snapshotDigest = createPublishSnapshotDigest({ platformId: payload.platformId, accountId: payload.accountId, snapshot: payload.snapshot });
    const approved = await options.approval.isApproved({ projectId: payload.projectId, targetType: 'PUBLISH', targetId: payload.targetId, reviewDecisionId: payload.reviewDecisionId, snapshotDigest });
    if (!approved) return { status: 'FAILED', failure: { code: 'HUMAN_CONFIRMATION_REQUIRED', classification: 'HUMAN_ACTION_REQUIRED', message: 'An approved PUBLISH review decision is required for this snapshot' } } satisfies PublishResult;
    if (payload.platformId !== 'fake-platform' && (!payload.snapshot.mediaPath || !/^[a-f0-9]{64}$/i.test(payload.snapshot.assetSha256 || ''))) {
      return { status: 'FAILED', failure: { code: 'UPLOAD_FAILED', classification: 'PERMANENT', message: 'Real publisher snapshots require a media path and SHA-256 checksum' } } satisfies PublishResult;
    }
    if (payload.platformId !== 'fake-platform') {
      const actualSha256 = createHash('sha256').update(await readFile(payload.snapshot.mediaPath as string)).digest('hex');
      if (actualSha256 !== payload.snapshot.assetSha256) return { status: 'FAILED', failure: { code: 'UPLOAD_FAILED', classification: 'PERMANENT', message: 'Publisher media checksum does not match the reviewed snapshot' } } satisfies PublishResult;
    }
    const credential = await options.credentials.resolve(payload.credentialRef);
    const profileDir = join(options.profileRoot, payload.platformId, payload.accountId);
    await mkdir(profileDir, { recursive: true });
    const context: PublisherContext = { profileDir, accountId: payload.accountId, credentialRef: payload.credentialRef, ...(Object.keys(credential).length ? { credential } : {}) };
    return adapter.publish(context, payload.snapshot);
  };
}

export type { PublisherCredential } from '../../../contracts/src/index.js';
