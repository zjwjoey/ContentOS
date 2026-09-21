import type { AvatarProvider, AvatarTaskStatus, SpeechGenerationRequest, SpeechGenerationResult, SpeechProvider, ProviderMediaStaging } from '../../../contracts/src/index.js';
import { DigitalHumanProviderError, FakeAvatarProvider, FakeSpeechProvider, IndexTTS25SpeechProvider, SignedProviderMediaStaging, isPublicHttpUrl } from './providers.js';

class UnavailableSpeechProvider implements SpeechProvider {
  readonly providerId: string;
  constructor(providerId: string, private readonly reason: string) { this.providerId = providerId; }
  async getCapabilities(): Promise<never> { throw new DigitalHumanProviderError('UNAVAILABLE', this.reason, true); }
  async generateSpeech(_request: SpeechGenerationRequest): Promise<SpeechGenerationResult> { throw new DigitalHumanProviderError('UNAVAILABLE', this.reason, true); }
}

class UnavailableMediaStaging implements ProviderMediaStaging {
  constructor(private readonly reason: string) {}
  async stageAsset(_assetId: string): Promise<{ publicUrl: string; expiresAt: string }> { throw new DigitalHumanProviderError('UNAVAILABLE', this.reason, true); }
}

class UnavailableAvatarProvider implements AvatarProvider {
  readonly providerId: string;
  constructor(providerId: string, private readonly reason: string) { this.providerId = providerId; }
  async getCapabilities(): Promise<never> { throw new DigitalHumanProviderError('UNAVAILABLE', this.reason, true); }
  async submitLipSync(): Promise<never> { throw new DigitalHumanProviderError('UNAVAILABLE', this.reason, true); }
  async getTask(_externalTaskId: string): Promise<AvatarTaskStatus> { throw new DigitalHumanProviderError('UNAVAILABLE', this.reason, true); }
}

export interface RuntimeDigitalHumanProviders { speech: SpeechProvider; avatar: AvatarProvider; staging: ProviderMediaStaging; mediaStagingConfigured: boolean; }
export interface RuntimeDigitalHumanEnvironment { CONTENTOS_SPEECH_PROVIDER?: string; CONTENTOS_INDEXTTS_BASE_URL?: string; CONTENTOS_AVATAR_PROVIDER?: string; CONTENTOS_MEDIA_STAGING_PROVIDER?: string; CONTENTOS_MEDIA_STAGING_BASE_URL?: string; CONTENTOS_MEDIA_STAGING_SECRET?: string; CONTENTOS_FAKE_SPEECH_OUTPUT_PATH?: string; CONTENTOS_PROVIDER_REQUEST_TIMEOUT_MS?: string; CONTENTOS_PROVIDER_CAPABILITY_TIMEOUT_MS?: string; }

function optionalTimeout(value: string | undefined): number | undefined { const parsed = value === undefined ? NaN : Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined; }

export function createRuntimeDigitalHumanProviders(env: RuntimeDigitalHumanEnvironment = process.env as RuntimeDigitalHumanEnvironment): RuntimeDigitalHumanProviders {
  const requestTimeoutMs = optionalTimeout(env.CONTENTOS_PROVIDER_REQUEST_TIMEOUT_MS); const capabilityTimeoutMs = optionalTimeout(env.CONTENTOS_PROVIDER_CAPABILITY_TIMEOUT_MS);
  const speechId = env.CONTENTOS_SPEECH_PROVIDER || 'indextts25';
  const speech = speechId === 'fake-speech'
    ? new FakeSpeechProvider(env.CONTENTOS_FAKE_SPEECH_OUTPUT_PATH || 'F:/ContentOS-AI/temp/fake-speech.wav')
    : speechId === 'indextts25'
      ? new IndexTTS25SpeechProvider({ baseUrl: env.CONTENTOS_INDEXTTS_BASE_URL || 'http://127.0.0.1:8788', ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }), ...(capabilityTimeoutMs === undefined ? {} : { capabilityTimeoutMs }) })
      : new UnavailableSpeechProvider(speechId, `Speech provider ${speechId} is not configured`);
  const avatarId = env.CONTENTOS_AVATAR_PROVIDER || 'hzagent';
  const avatar = avatarId === 'fake-avatar'
    ? new FakeAvatarProvider()
    : new UnavailableAvatarProvider(avatarId, 'AvatarProvider API integration is interface-only until an official vendor contract is supplied');
  const stagingProvider = env.CONTENTOS_MEDIA_STAGING_PROVIDER || 'http';
  const stagingBaseUrl = env.CONTENTOS_MEDIA_STAGING_BASE_URL || '';
  const publicStagingBaseUrl = isPublicHttpUrl(stagingBaseUrl);
  const staging = stagingProvider === 'signed-url' && publicStagingBaseUrl && env.CONTENTOS_MEDIA_STAGING_SECRET
    ? new SignedProviderMediaStaging({ baseUrl: stagingBaseUrl, secret: env.CONTENTOS_MEDIA_STAGING_SECRET })
    : new UnavailableMediaStaging('Signed provider media staging is not configured');
  const mediaStagingConfigured = avatarId === 'fake-avatar' || (stagingProvider === 'signed-url' ? Boolean(publicStagingBaseUrl && env.CONTENTOS_MEDIA_STAGING_SECRET) : false);
  return { speech, avatar, staging, mediaStagingConfigured };
}
