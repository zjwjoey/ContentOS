import { createHash } from 'node:crypto';
import type { MediaAnalysisAsrSegmentV1, MediaAnalysisShotV1, MediaAnalysisVisionResultV1, TechnicalMediaAnalysisV1 } from '../../../contracts/src/index.js';

export interface TechnicalMediaProvider {
  probe(input: { assetId: string; runId: string; metadata: Record<string, unknown> }): Promise<Omit<TechnicalMediaAnalysisV1, 'runId' | 'assetId'>>;
}
export interface AsrProvider {
  transcribe(input: { assetId: string; runId: string; durationMs: number; metadata: Record<string, unknown> }): Promise<Array<Omit<MediaAnalysisAsrSegmentV1, 'id' | 'runId' | 'assetId'>>>;
}
export interface VisionProvider {
  analyze(input: { assetId: string; runId: string; shots: MediaAnalysisShotV1[]; metadata: Record<string, unknown> }): Promise<Array<Omit<MediaAnalysisVisionResultV1, 'id' | 'runId' | 'assetId'>>>;
}
export interface EmbeddingProvider {
  embed(input: { text: string; modelVersion: string }): Promise<{ vector: number[]; provider: string; modelVersion: string }>;
}
export interface IntelligenceProviders { technical: TechnicalMediaProvider; asr: AsrProvider; vision: VisionProvider; embedding: EmbeddingProvider; mode: 'FAKE' | 'REAL'; }

function numberMetadata(metadata: Record<string, unknown>, key: string, fallback: number): number { const value = metadata[key]; return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback; }

export class FakeTechnicalMediaProvider implements TechnicalMediaProvider {
  async probe(input: { assetId: string; runId: string; metadata: Record<string, unknown> }): Promise<Omit<TechnicalMediaAnalysisV1, 'runId' | 'assetId'>> {
    const durationMs = numberMetadata(input.metadata, 'durationMs', 1_000);
    return { durationMs, width: Math.trunc(numberMetadata(input.metadata, 'width', 1080)), height: Math.trunc(numberMetadata(input.metadata, 'height', 1920)), fps: numberMetadata(input.metadata, 'fps', 30) || null, format: typeof input.metadata.format === 'string' ? input.metadata.format : 'unknown', videoCodec: typeof input.metadata.codec === 'string' ? input.metadata.codec : null, audioCodec: null, hasAudio: Boolean(input.metadata.hasAudio), provider: 'FAKE_TECHNICAL', modelVersion: 'fake-1' };
  }
}

export class FakeAsrProvider implements AsrProvider {
  async transcribe(input: { assetId: string; runId: string; durationMs: number; metadata: Record<string, unknown> }): Promise<Array<Omit<MediaAnalysisAsrSegmentV1, 'id' | 'runId' | 'assetId'>>> {
    const text = typeof input.metadata.transcript === 'string' && input.metadata.transcript.trim() ? input.metadata.transcript.trim() : `素材 ${input.assetId} 的可编辑语音片段`;
    return [{ startMs: 0, endMs: Math.max(1, input.durationMs), text, speaker: null, confidence: 0.5, provider: 'FAKE_ASR', modelVersion: 'fake-1' }];
  }
}

export class FakeVisionProvider implements VisionProvider {
  async analyze(input: { assetId: string; runId: string; shots: MediaAnalysisShotV1[]; metadata: Record<string, unknown> }): Promise<Array<Omit<MediaAnalysisVisionResultV1, 'id' | 'runId' | 'assetId'>>> {
    const tags = Array.isArray(input.metadata.tags) ? input.metadata.tags.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 16) : ['video'];
    return [{ shotId: input.shots[0]?.id || null, summary: typeof input.metadata.notes === 'string' && input.metadata.notes.trim() ? input.metadata.notes.trim() : `素材 ${input.assetId} 的视觉摘要`, tags: tags.map((tag) => ({ tag, confidence: 0.5, evidenceTimestampsMs: input.shots[0] ? [input.shots[0].sourceInMs] : [0] })), provider: 'FAKE_VISION', modelVersion: 'fake-1', promptVersion: 'fake-vision-v1' }];
  }
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  async embed(input: { text: string; modelVersion: string }): Promise<{ vector: number[]; provider: string; modelVersion: string }> {
    const digest = createHash('sha256').update(input.text).digest();
    const vector = Array.from({ length: 16 }, (_, index) => (digest[index]! / 255) * 2 - 1);
    return { vector, provider: 'FAKE_EMBEDDING', modelVersion: input.modelVersion || 'fake-1' };
  }
}

export function createFakeIntelligenceProviders(): IntelligenceProviders {
  return { technical: new FakeTechnicalMediaProvider(), asr: new FakeAsrProvider(), vision: new FakeVisionProvider(), embedding: new FakeEmbeddingProvider(), mode: 'FAKE' };
}
