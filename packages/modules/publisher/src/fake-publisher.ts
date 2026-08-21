import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthResult, ExternalStateResult, PlatformCapabilityProfile, PublishResult, PublishSnapshot, PublisherAdapter, PublisherContext, PublisherFailure, PublisherFailureCode } from '../../../contracts/src/index.js';

export type FakeOutcome = 'SUCCESS' | 'AUTH_EXPIRED' | 'VERIFICATION' | 'DOM_DRIFT' | 'BROWSER_CRASH' | 'RATE_LIMIT' | 'NETWORK';
const failureMap: Record<Exclude<FakeOutcome, 'SUCCESS'>, PublisherFailure> = {
  AUTH_EXPIRED: { code: 'AUTH_EXPIRED', classification: 'HUMAN_ACTION_REQUIRED', message: 'Fake account requires re-authentication' },
  VERIFICATION: { code: 'REQUIRES_VERIFICATION', classification: 'HUMAN_ACTION_REQUIRED', message: 'Fake platform requested human verification' },
  DOM_DRIFT: { code: 'PLATFORM_CHANGED', classification: 'PERMANENT', message: 'Fake platform changed its page contract' },
  BROWSER_CRASH: { code: 'UNKNOWN_EXTERNAL_STATE', classification: 'RECONCILIATION_REQUIRED', message: 'Fake browser crashed after an uncertain side effect' },
  RATE_LIMIT: { code: 'RATE_LIMIT', classification: 'RETRYABLE', message: 'Fake platform rate limited the request' },
  NETWORK: { code: 'NETWORK_ERROR', classification: 'RETRYABLE', message: 'Fake network failed before confirmation' },
};

export class FakePublisherAdapter implements PublisherAdapter {
  public readonly outcome: FakeOutcome;
  private readonly published = new Map<string, string>();
  constructor(outcome: FakeOutcome = 'SUCCESS') { this.outcome = outcome; }
  capabilities(): PlatformCapabilityProfile { return { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false }; }
  async authenticate(_context: PublisherContext): Promise<AuthResult> {
    if (this.outcome === 'AUTH_EXPIRED') return { status: 'FAILED', failure: failureMap.AUTH_EXPIRED };
    return { status: 'AUTHENTICATED' };
  }
  async publish(_context: PublisherContext, snapshot: PublishSnapshot): Promise<PublishResult> {
    if (this.outcome !== 'SUCCESS') {
      const failure = failureMap[this.outcome];
      return { status: failure.code === 'UNKNOWN_EXTERNAL_STATE' ? 'UNKNOWN_EXTERNAL_STATE' : 'FAILED', failure: { ...failure } };
    }
    const existing = this.published.get(snapshot.idempotencyKey);
    if (existing) return { status: 'PUBLISHED', externalPostId: existing };
    const externalPostId = `fake-post-${createHash('sha256').update(snapshot.idempotencyKey).digest('hex').slice(0, 16)}`;
    this.published.set(snapshot.idempotencyKey, externalPostId);
    return { status: 'PUBLISHED', externalPostId };
  }
  async reconcile(_context: PublisherContext, idempotencyKey: string): Promise<ExternalStateResult> {
    const externalPostId = this.published.get(idempotencyKey);
    return externalPostId ? { status: 'PUBLISHED', externalPostId } : { status: 'NOT_FOUND' };
  }
}

export class FakePublisherService {
  constructor(private readonly profileRoot: string, private readonly adapter: PublisherAdapter = new FakePublisherAdapter()) {}
  profileDirectory(accountId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error('Invalid publisher account id');
    return join(this.profileRoot, accountId);
  }
  async publish(accountId: string, snapshot: PublishSnapshot): Promise<PublishResult> {
    const profileDir = this.profileDirectory(accountId);
    await mkdir(profileDir, { recursive: true });
    const context: PublisherContext = { profileDir, credentialRef: `fake-credential:${accountId}` };
    const auth = await this.adapter.authenticate(context);
    if (auth.status === 'FAILED') return { status: 'FAILED', ...(auth.failure ? { failure: auth.failure } : {}) };
    return this.adapter.publish(context, snapshot);
  }
}
