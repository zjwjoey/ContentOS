import { createHash } from 'node:crypto';
import { probeMedia } from '../../../infrastructure/ffmpeg/src/index.js';
import { detectShotsV1, type DetectedShot } from '../../video/src/shot-detection.js';
import { QwenEmbeddingProvider, QwenVisualAnalysisProvider } from '../../video/src/index.js';
import { join, resolve } from 'node:path';
import type { MediaAnalysisAsrSegmentV1, MediaAnalysisShotV1, MediaAnalysisVisionResultV1, TechnicalMediaAnalysisV1 } from '../../../contracts/src/index.js';

export interface TechnicalMediaProvider {
  probe(input: { assetId: string; runId: string; metadata: Record<string, unknown>; sourcePath?: string; signal?: AbortSignal }): Promise<Omit<TechnicalMediaAnalysisV1, 'runId' | 'assetId'>>;
}
export interface ShotDetectionProvider {
  detect(input: { assetId: string; runId: string; sourcePath?: string; durationMs: number; signal?: AbortSignal }): Promise<Array<Pick<MediaAnalysisShotV1, 'sourceInMs' | 'sourceOutMs' | 'confidence' | 'detectionVersion'>>>;
}
export interface AsrProvider {
  transcribe(input: { assetId: string; runId: string; durationMs: number; metadata: Record<string, unknown>; signal?: AbortSignal }): Promise<Array<Omit<MediaAnalysisAsrSegmentV1, 'id' | 'runId' | 'assetId'>>>;
}
export interface VisionProvider {
  analyze(input: { assetId: string; runId: string; shots: MediaAnalysisShotV1[]; metadata: Record<string, unknown>; signal?: AbortSignal }): Promise<Array<Omit<MediaAnalysisVisionResultV1, 'id' | 'runId' | 'assetId'>>>;
}
export interface EmbeddingProvider {
  embed(input: { text: string; modelVersion: string; signal?: AbortSignal }): Promise<{ vector: number[]; provider: string; modelVersion: string }>;
}
export interface IntelligenceProviderConfig { ffmpegPath?: string; ffprobePath?: string; keyframeRoot?: string; realProvidersEnabled: boolean; asrProvider?: string; visionProvider?: string; embeddingProvider?: string; }
export interface IntelligenceProviders { technical: TechnicalMediaProvider; shots: ShotDetectionProvider; asr: AsrProvider; vision: VisionProvider; embedding: EmbeddingProvider; mode: 'FAKE' | 'REAL'; }

function numberMetadata(metadata: Record<string, unknown>, key: string, fallback: number): number { const value = metadata[key]; return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback; }

export class FakeTechnicalMediaProvider implements TechnicalMediaProvider {
  async probe(input: { assetId: string; runId: string; metadata: Record<string, unknown> }): Promise<Omit<TechnicalMediaAnalysisV1, 'runId' | 'assetId'>> {
    const durationMs = numberMetadata(input.metadata, 'durationMs', 1_000);
    return { durationMs, width: Math.trunc(numberMetadata(input.metadata, 'width', 1080)), height: Math.trunc(numberMetadata(input.metadata, 'height', 1920)), fps: numberMetadata(input.metadata, 'fps', 30) || null, format: typeof input.metadata.format === 'string' ? input.metadata.format : 'unknown', videoCodec: typeof input.metadata.codec === 'string' ? input.metadata.codec : null, audioCodec: null, hasAudio: Boolean(input.metadata.hasAudio), provider: 'FAKE_TECHNICAL', modelVersion: 'fake-1' };
  }
}

export class FfprobeTechnicalMediaProvider implements TechnicalMediaProvider {
  constructor(private readonly ffprobePath = 'ffprobe') {}
  async probe(input: { assetId: string; runId: string; metadata: Record<string, unknown>; sourcePath?: string; signal?: AbortSignal }): Promise<Omit<TechnicalMediaAnalysisV1, 'runId' | 'assetId'>> {
    if (!input.sourcePath) throw Object.assign(new Error('REAL_TECHNICAL_SOURCE_PATH_REQUIRED'), { code: 'REAL_TECHNICAL_SOURCE_PATH_REQUIRED', retryable: false });
    input.signal?.throwIfAborted();
    const media = await probeMedia(input.sourcePath, this.ffprobePath, input.signal);
    return { durationMs: media.durationMs, width: media.width, height: media.height, fps: media.fps ?? null, format: media.format, videoCodec: media.videoCodec ?? null, audioCodec: media.audioCodec ?? null, hasAudio: media.audio, provider: 'FFPROBE', modelVersion: 'ffprobe-v1' };
  }
}

export class FakeShotDetectionProvider implements ShotDetectionProvider {
  async detect(input: { durationMs: number }): Promise<Array<Pick<MediaAnalysisShotV1, 'sourceInMs' | 'sourceOutMs' | 'confidence' | 'detectionVersion'>>> {
    const count = Math.max(1, Math.ceil(input.durationMs / 5_000));
    return Array.from({ length: count }, (_, index) => ({ sourceInMs: Math.floor(index * input.durationMs / count), sourceOutMs: Math.max(1, Math.floor((index + 1) * input.durationMs / count)), confidence: 0.5, detectionVersion: 'fake-uniform-v1' }));
  }
}

export class FfmpegShotDetectionProvider implements ShotDetectionProvider {
  constructor(private readonly ffmpegPath = 'ffmpeg') {}
  async detect(input: { assetId?: string; runId?: string; sourcePath?: string; durationMs: number; signal?: AbortSignal }): Promise<Array<Pick<MediaAnalysisShotV1, 'sourceInMs' | 'sourceOutMs' | 'confidence' | 'detectionVersion'>>> {
    if (!input.sourcePath) throw Object.assign(new Error('REAL_SHOT_SOURCE_PATH_REQUIRED'), { code: 'REAL_SHOT_SOURCE_PATH_REQUIRED', retryable: false });
    const shots: DetectedShot[] = await detectShotsV1({ sourcePath: input.sourcePath, durationMs: input.durationMs, ffmpegPath: this.ffmpegPath, ...(input.signal ? { signal: input.signal } : {}) });
    return shots.map((shot) => ({ sourceInMs: shot.sourceInMs, sourceOutMs: shot.sourceOutMs, confidence: shot.confidence, detectionVersion: 'shot-detection-v1' }));
  }
}

export class FakeAsrProvider implements AsrProvider {
  async transcribe(input: { assetId: string; runId: string; durationMs: number; metadata: Record<string, unknown> }): Promise<Array<Omit<MediaAnalysisAsrSegmentV1, 'id' | 'runId' | 'assetId'>>> {
    const text = typeof input.metadata.transcript === 'string' && input.metadata.transcript.trim() ? input.metadata.transcript.trim() : `素材 ${input.assetId} 的可编辑语音片段`;
    return [{ segmentIndex: 0, startMs: 0, endMs: Math.max(1, input.durationMs), text, speaker: null, confidence: 0.5, provider: 'FAKE_ASR', modelVersion: 'fake-1' }];
  }
}

export class FakeVisionProvider implements VisionProvider {
  async analyze(input: { assetId: string; runId: string; shots: MediaAnalysisShotV1[]; metadata: Record<string, unknown>; signal?: AbortSignal }): Promise<Array<Omit<MediaAnalysisVisionResultV1, 'id' | 'runId' | 'assetId'>>> {
    const tags = Array.isArray(input.metadata.tags) ? input.metadata.tags.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 16) : ['video'];
    return input.shots.map((shot) => {
      input.signal?.throwIfAborted();
      const summary = typeof input.metadata.notes === 'string' && input.metadata.notes.trim() ? `${input.metadata.notes.trim()}（镜头 ${shot.shotIndex + 1}）` : `素材 ${input.assetId} 的第 ${shot.shotIndex + 1} 个镜头`;
      return { shotId: shot.id, summary, tags: tags.map((tag) => ({ tag, confidence: 0.5, evidenceTimestampsMs: [shot.sourceInMs] })), objects: tags, actions: [], location: null, shotType: 'unknown', cameraMotion: 'unknown', peopleCount: null, qualitySignals: {}, provider: 'FAKE_VISION', modelVersion: 'fake-1', promptVersion: 'fake-vision-v1' };
    });
  }
}

class UnconfiguredRealAsrProvider implements AsrProvider {
  async transcribe(): Promise<Array<Omit<MediaAnalysisAsrSegmentV1, 'id' | 'runId' | 'assetId'>>> { throw Object.assign(new Error('REAL_ASR_PROVIDER_NOT_CONFIGURED'), { code: 'REAL_ASR_PROVIDER_NOT_CONFIGURED', retryable: false }); }
}
class UnconfiguredRealVisionProvider implements VisionProvider {
  async analyze(): Promise<Array<Omit<MediaAnalysisVisionResultV1, 'id' | 'runId' | 'assetId'>>> { throw Object.assign(new Error('REAL_VISION_PROVIDER_NOT_CONFIGURED'), { code: 'REAL_VISION_PROVIDER_NOT_CONFIGURED', retryable: false }); }
}

class QwenShotVisionProvider implements VisionProvider {
  private readonly provider = new QwenVisualAnalysisProvider();
  constructor(private readonly keyframeRoot: string) {}
  async analyze(input: { assetId: string; runId: string; shots: MediaAnalysisShotV1[]; metadata: Record<string, unknown>; signal?: AbortSignal }): Promise<Array<Omit<MediaAnalysisVisionResultV1, 'id' | 'runId' | 'assetId'>>> {
    const results: Array<Omit<MediaAnalysisVisionResultV1, 'id' | 'runId' | 'assetId'>> = [];
    for (const shot of input.shots) {
      input.signal?.throwIfAborted();
      const framePath = join(resolve(this.keyframeRoot), input.runId, `${shot.id}.jpg`);
      const profile = await this.provider.analyzeAssetFrames({ assetId: `${input.assetId}:${shot.id}`, framePaths: [framePath], frameTimestampsMs: [Math.floor((shot.sourceInMs + shot.sourceOutMs) / 2)], ...(input.signal ? { signal: input.signal } : {}) });
      results.push({ shotId: shot.id, summary: profile.summary, tags: profile.tags.map((tag) => ({ tag: tag.tag, confidence: tag.confidence, evidenceTimestampsMs: tag.timestampsMs })), objects: profile.tags.map((tag) => tag.tag), actions: [], location: null, shotType: 'unknown', cameraMotion: 'unknown', peopleCount: null, qualitySignals: {}, provider: profile.modelProvider, modelVersion: profile.modelVersion, promptVersion: profile.promptVersion });
    }
    return results;
  }
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  async embed(input: { text: string; modelVersion: string }): Promise<{ vector: number[]; provider: string; modelVersion: string }> {
    const digest = createHash('sha256').update(input.text).digest();
    const vector = Array.from({ length: 16 }, (_, index) => (digest[index]! / 255) * 2 - 1);
    return { vector, provider: 'FAKE_EMBEDDING', modelVersion: input.modelVersion || 'fake-1' };
  }
}

class UnconfiguredRealEmbeddingProvider implements EmbeddingProvider {
  async embed(): Promise<{ vector: number[]; provider: string; modelVersion: string }> { throw Object.assign(new Error('REAL_EMBEDDING_PROVIDER_NOT_CONFIGURED'), { code: 'REAL_EMBEDDING_PROVIDER_NOT_CONFIGURED', retryable: false }); }
}

class QwenShotEmbeddingProvider implements EmbeddingProvider {
  private readonly provider = new QwenEmbeddingProvider();
  async embed(input: { text: string; modelVersion: string; signal?: AbortSignal }): Promise<{ vector: number[]; provider: string; modelVersion: string }> {
    const result = await this.provider.embed({ texts: [input.text], model: input.modelVersion, ...(input.signal ? { signal: input.signal } : {}) });
    return { vector: result.vectors[0] || [], provider: result.provider, modelVersion: result.model };
  }
}

export function createFakeIntelligenceProviders(): IntelligenceProviders {
  return { technical: new FakeTechnicalMediaProvider(), shots: new FakeShotDetectionProvider(), asr: new FakeAsrProvider(), vision: new FakeVisionProvider(), embedding: new FakeEmbeddingProvider(), mode: 'FAKE' };
}

export function createIntelligenceProviders(config: IntelligenceProviderConfig): IntelligenceProviders {
  if (!config.realProvidersEnabled) return createFakeIntelligenceProviders();
  const vision = config.visionProvider === 'qwen' && config.keyframeRoot ? new QwenShotVisionProvider(config.keyframeRoot) : new UnconfiguredRealVisionProvider();
  const embedding = config.embeddingProvider === 'qwen' ? new QwenShotEmbeddingProvider() : new UnconfiguredRealEmbeddingProvider();
  return { technical: new FfprobeTechnicalMediaProvider(config.ffprobePath), shots: new FfmpegShotDetectionProvider(config.ffmpegPath), asr: new UnconfiguredRealAsrProvider(), vision, embedding, mode: 'REAL' };
}
