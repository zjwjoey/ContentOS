import { createHash } from 'node:crypto';

export type PublisherFailureCode = 'AUTH_EXPIRED' | 'REQUIRES_VERIFICATION' | 'PLATFORM_CHANGED' | 'RATE_LIMIT' | 'UPLOAD_FAILED' | 'NETWORK_ERROR' | 'UNKNOWN_EXTERNAL_STATE' | 'UNKNOWN';
export type PublisherFailureClassification = 'HUMAN_ACTION_REQUIRED' | 'PERMANENT' | 'RETRYABLE' | 'RECONCILIATION_REQUIRED' | 'TERMINAL';
export type PublisherAccountStatus = 'UNVERIFIED' | 'READY' | 'REAUTH_REQUIRED' | 'SUSPENDED' | 'DISABLED';
export type PublisherRequestStatus = 'DRAFT' | 'SCHEDULED' | 'QUEUED' | 'PUBLISHING' | 'RECONCILING' | 'PUBLISHED' | 'FAILED' | 'CANCELLED';
export type PublisherAttemptOperation = 'PUBLISH' | 'RECONCILE';
export type PublisherAttemptStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
export type PublisherPlatformId = 'fake-platform' | 'douyin' | 'wechat-channels';
export interface PublisherCredential { accessToken?: string; refreshToken?: string; clientKey?: string; clientSecret?: string; openId?: string; }
export interface PublisherFailure { code: PublisherFailureCode; classification: PublisherFailureClassification; message: string; }
export interface PublisherAccount { id: string; projectId: string; platformId: string; displayName: string; credentialRef: string; profileKey: string; status: PublisherAccountStatus; capabilitySnapshot: PlatformCapabilityProfile; createdAt: string; updatedAt: string; }
export interface PublisherRequest { id: string; projectId: string; accountId: string; currentRevisionId: string | null; status: PublisherRequestStatus; idempotencyKey: string; desiredPublishAt: string | null; nextRetryAt: string | null; failureCode: PublisherFailureCode | null; failureMessage: string | null; correlationId: string; createdAt: string; updatedAt: string; publishedAt: string | null; }
export interface PublisherRequestRevision { id: string; requestId: string; revision: number; assetId: string; assetChecksum: string; title: string; description: string; hashtags: string[]; coverAssetId?: string; desiredPublishAt: string | null; createdBy: string; createdAt: string; }
export interface PublisherAttempt { id: string; requestId: string; revisionId: string; jobId: string | null; jobAttemptId: string | null; attemptNumber: number; operation: PublisherAttemptOperation; status: PublisherAttemptStatus; failureCode: PublisherFailureCode | null; failureClassification: PublisherFailureClassification | null; diagnostics: Record<string, unknown>; startedAt: string; finishedAt: string | null; }
export interface PublisherExternalPost { id: string; requestId: string; accountId: string; platformId: string; externalPostId: string; externalUrl: string | null; firstObservedAt: string; lastReconciledAt: string | null; }
export interface PlatformCapabilityProfile { platformId: string; mediaTypes: string[]; scheduling: boolean; requiresHumanConfirmation: boolean; }
export interface PublisherContext { profileDir: string; accountId?: string; credentialRef: string; credential?: PublisherCredential; }
export interface PublishSnapshot { requestId: string; idempotencyKey: string; assetId: string; assetSha256?: string; mediaPath?: string; coverPath?: string; coverSha256?: string; title: string; description: string; hashtags?: string[]; }
export interface AuthResult { status: 'AUTHENTICATED' | 'FAILED'; failure?: PublisherFailure; }
export interface PublishResult { status: 'PUBLISHED' | 'FAILED' | 'UNKNOWN_EXTERNAL_STATE'; externalPostId?: string; failure?: PublisherFailure; }
export interface ExternalStateResult { status: 'PUBLISHED' | 'NOT_FOUND' | 'UNKNOWN'; externalPostId?: string; }
export interface PublisherAdapter {
  capabilities(): PlatformCapabilityProfile;
  authenticate(context: PublisherContext): Promise<AuthResult>;
  publish(context: PublisherContext, snapshot: PublishSnapshot): Promise<PublishResult>;
  reconcile(context: PublisherContext, idempotencyKey: string): Promise<ExternalStateResult>;
}

export function createPublishSnapshotDigest(input: { platformId: PublisherPlatformId; accountId: string; snapshot: PublishSnapshot }): string {
  const { platformId, accountId, snapshot } = input;
  const canonical = JSON.stringify({
    schemaVersion: 'PUBLISH_SNAPSHOT_V1', platformId, accountId, assetId: snapshot.assetId,
    assetSha256: snapshot.assetSha256 || null, coverSha256: snapshot.coverSha256 || null,
    title: snapshot.title, description: snapshot.description, hashtags: snapshot.hashtags || [],
  });
  return createHash('sha256').update(canonical).digest('hex');
}

const allowedTransitions: Record<PublisherRequestStatus, readonly PublisherRequestStatus[]> = {
  DRAFT: ['SCHEDULED', 'QUEUED', 'CANCELLED'],
  SCHEDULED: ['QUEUED', 'CANCELLED'],
  QUEUED: ['PUBLISHING', 'CANCELLED'],
  PUBLISHING: ['PUBLISHED', 'FAILED', 'RECONCILING'],
  RECONCILING: ['PUBLISHED', 'QUEUED', 'FAILED'],
  PUBLISHED: [],
  FAILED: ['QUEUED', 'CANCELLED'],
  CANCELLED: [],
};

export function assertPublisherRequestTransition(from: PublisherRequestStatus, to: PublisherRequestStatus): void {
  if (!allowedTransitions[from].includes(to)) throw new Error(`Invalid Publisher request transition: ${from} -> ${to}`);
}
