import type { AvatarCapabilities, AvatarProvider, AvatarTaskStatus, SpeechCapabilities, SpeechGenerationRequest, SpeechGenerationResult, SpeechProvider, ProviderMediaStaging } from '../../../contracts/src/index.js';
import { DigitalHumanProviderError, FakeAvatarProvider, FakeSpeechProvider, HttpAvatarProvider, HttpProviderMediaStaging, HzAgentAvatarProvider, IndexTTS25SpeechProvider } from './providers.js';

class UnavailableSpeechProvider implements SpeechProvider {
  readonly providerId: string;
  constructor(providerId: string, private readonly reason: string) { this.providerId = providerId; }
  async getCapabilities(): Promise<SpeechCapabilities> { return { providerId: this.providerId, local: true, voiceClone: false, emotion: false, speed: false, languages: [], supportsReferenceAudio: false, requiresReferenceAudio: false, supportsVoiceId: false }; }
  async generateSpeech(_request: SpeechGenerationRequest): Promise<SpeechGenerationResult> { throw new DigitalHumanProviderError('UNAVAILABLE', this.reason, true); }
}

class UnavailableMediaStaging implements ProviderMediaStaging {
  constructor(private readonly reason: string) {}
  async stageAsset(_assetId: string): Promise<{ publicUrl: string; expiresAt: string }> { throw new DigitalHumanProviderError('UNAVAILABLE', this.reason, true); }
}

class UnavailableAvatarProvider implements AvatarProvider {
  readonly providerId: string;
  constructor(providerId: string, private readonly reason: string) { this.providerId = providerId; }
  async getCapabilities(): Promise<AvatarCapabilities> { return { providerId: this.providerId, local: false, videoToVideo: false, imageToVideo: false, requiresPublicUrl: true, supportedFormats: [] }; }
  async submitLipSync(): Promise<never> { throw new DigitalHumanProviderError('UNAVAILABLE', this.reason, true); }
  async getTask(_externalTaskId: string): Promise<AvatarTaskStatus> { throw new DigitalHumanProviderError('UNAVAILABLE', this.reason, true); }
}

export interface RuntimeDigitalHumanProviders { speech: SpeechProvider; avatar: AvatarProvider; staging: ProviderMediaStaging; mediaStagingConfigured: boolean; }
export interface RuntimeDigitalHumanEnvironment { CONTENTOS_SPEECH_PROVIDER?: string; CONTENTOS_INDEXTTS_BASE_URL?: string; CONTENTOS_AVATAR_PROVIDER?: string; HZAGENT_BASE_URL?: string; HZAGENT_API_KEY?: string; CONTENTOS_MEDIA_STAGING_BASE_URL?: string; CONTENTOS_MEDIA_STAGING_API_KEY?: string; CONTENTOS_FAKE_SPEECH_OUTPUT_PATH?: string; }

export function createRuntimeDigitalHumanProviders(env: RuntimeDigitalHumanEnvironment = process.env as RuntimeDigitalHumanEnvironment): RuntimeDigitalHumanProviders {
  const speechId = env.CONTENTOS_SPEECH_PROVIDER || 'indextts25';
  const speech = speechId === 'fake-speech'
    ? new FakeSpeechProvider(env.CONTENTOS_FAKE_SPEECH_OUTPUT_PATH || 'F:/ContentOS-AI/temp/fake-speech.wav')
    : speechId === 'indextts25'
      ? new IndexTTS25SpeechProvider({ baseUrl: env.CONTENTOS_INDEXTTS_BASE_URL || 'http://127.0.0.1:8788' })
      : new UnavailableSpeechProvider(speechId, `Speech provider ${speechId} is not configured`);
  const avatarId = env.CONTENTOS_AVATAR_PROVIDER || 'hzagent';
  const avatar = avatarId === 'fake-avatar'
    ? new FakeAvatarProvider()
    : env.HZAGENT_API_KEY
      ? avatarId === 'hzagent'
        ? new HzAgentAvatarProvider({ baseUrl: env.HZAGENT_BASE_URL || 'https://api.ai.hzagent.cn', apiKey: env.HZAGENT_API_KEY })
        : new HttpAvatarProvider({ providerId: avatarId, baseUrl: env.HZAGENT_BASE_URL || 'https://api.ai.hzagent.cn', apiKey: env.HZAGENT_API_KEY })
      : new UnavailableAvatarProvider(avatarId, 'Avatar provider API key is not configured');
  const staging = env.CONTENTOS_MEDIA_STAGING_BASE_URL
    ? new HttpProviderMediaStaging({ baseUrl: env.CONTENTOS_MEDIA_STAGING_BASE_URL, ...(env.CONTENTOS_MEDIA_STAGING_API_KEY ? { apiKey: env.CONTENTOS_MEDIA_STAGING_API_KEY } : {}) })
    : new UnavailableMediaStaging('Provider media staging is not configured');
  return { speech, avatar, staging, mediaStagingConfigured: Boolean(env.CONTENTOS_MEDIA_STAGING_BASE_URL) || avatarId === 'fake-avatar' };
}
