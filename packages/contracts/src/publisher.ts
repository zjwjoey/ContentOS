export type PublisherFailureCode = 'AUTH_EXPIRED' | 'REQUIRES_VERIFICATION' | 'PLATFORM_CHANGED' | 'RATE_LIMIT' | 'UPLOAD_FAILED' | 'NETWORK_ERROR' | 'UNKNOWN_EXTERNAL_STATE' | 'UNKNOWN';
export type PublisherFailureClassification = 'HUMAN_ACTION_REQUIRED' | 'PERMANENT' | 'RETRYABLE' | 'RECONCILIATION_REQUIRED' | 'TERMINAL';
export type PublisherPlatformId = 'fake-platform' | 'douyin' | 'wechat-channels';
export interface PublisherCredential { accessToken?: string; refreshToken?: string; clientKey?: string; clientSecret?: string; openId?: string; }
export interface PublisherFailure { code: PublisherFailureCode; classification: PublisherFailureClassification; message: string; }
export interface PlatformCapabilityProfile { platformId: PublisherPlatformId; mediaTypes: string[]; scheduling: boolean; requiresHumanConfirmation: boolean; }
export interface PublisherContext { profileDir: string; credentialRef: string; credential?: PublisherCredential; }
export interface PublishSnapshot { requestId: string; idempotencyKey: string; assetId: string; mediaPath?: string; coverPath?: string; title: string; description: string; }
export interface AuthResult { status: 'AUTHENTICATED' | 'FAILED'; failure?: PublisherFailure; }
export interface PublishResult { status: 'PUBLISHED' | 'FAILED' | 'UNKNOWN_EXTERNAL_STATE'; externalPostId?: string; failure?: PublisherFailure; }
export interface ExternalStateResult { status: 'PUBLISHED' | 'NOT_FOUND' | 'UNKNOWN'; externalPostId?: string; }
export interface PublisherAdapter {
  capabilities(): PlatformCapabilityProfile;
  authenticate(context: PublisherContext): Promise<AuthResult>;
  publish(context: PublisherContext, snapshot: PublishSnapshot): Promise<PublishResult>;
  reconcile(context: PublisherContext, idempotencyKey: string): Promise<ExternalStateResult>;
}
