import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DetectedShot = { sourceInMs: number; sourceOutMs: number; confidence: number; evidence: Record<string, unknown> };

export const DEFAULT_SHOT_DETECTION_THRESHOLD = 0.35;
export const DEFAULT_SHOT_DETECTION_MIN_DURATION_MS = 800;

export function mergeShortDetectedShots(shots: DetectedShot[], minDurationMs = DEFAULT_SHOT_DETECTION_MIN_DURATION_MS): DetectedShot[] {
  if (shots.length < 2 || minDurationMs <= 0) return shots;
  const merged: DetectedShot[] = [];
  for (const shot of shots) {
    const previous = merged.at(-1);
    if (previous && shot.sourceOutMs - shot.sourceInMs < minDurationMs) {
      previous.sourceOutMs = shot.sourceOutMs;
      previous.confidence = Math.min(previous.confidence, shot.confidence);
      previous.evidence = { ...previous.evidence, mergedShortSegmentMs: shot.sourceOutMs - shot.sourceInMs };
    } else merged.push({ ...shot, evidence: { ...shot.evidence } });
  }
  if (merged.length > 1 && merged[0]!.sourceOutMs - merged[0]!.sourceInMs < minDurationMs) {
    const first = merged.shift()!;
    merged[0]!.sourceInMs = first.sourceInMs;
    merged[0]!.confidence = Math.min(merged[0]!.confidence, first.confidence);
  }
  return merged;
}

export async function detectShotsV1(input: { sourcePath: string; durationMs: number; threshold?: number; ffmpegPath?: string; signal?: AbortSignal }): Promise<DetectedShot[]> {
  const threshold = input.threshold ?? Number(process.env.SHOT_DETECTION_THRESHOLD || DEFAULT_SHOT_DETECTION_THRESHOLD);
  const minDurationMs = Number(process.env.SHOT_DETECTION_MIN_DURATION_MS || DEFAULT_SHOT_DETECTION_MIN_DURATION_MS);
  if (input.durationMs <= 0) throw new Error('SHOT_DETECTION_DURATION_INVALID');
  const result = await execFileAsync(input.ffmpegPath || 'ffmpeg', ['-hide_banner', '-i', input.sourcePath, '-vf', `select=gt(scene\,${threshold}),showinfo`, '-an', '-f', 'null', '-'], { maxBuffer: 4 * 1024 * 1024, signal: input.signal });
  const cuts = [...`${result.stdout}\n${result.stderr}`.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/gu)].map((match) => Math.round(Number(match[1]) * 1000)).filter((value) => value > 0 && value < input.durationMs);
  const points = [0, ...[...new Set(cuts)].sort((a, b) => a - b), Math.round(input.durationMs)];
  const shots: DetectedShot[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const sourceInMs = points[index]!;
    const sourceOutMs = points[index + 1]!;
    if (sourceOutMs <= sourceInMs) continue;
    shots.push({ sourceInMs, sourceOutMs, confidence: cuts.includes(sourceInMs) ? 0.8 : 1, evidence: { detector: 'ffmpeg-scene', threshold, detectorVersion: 'shot-detection-v1' } });
  }
  return mergeShortDetectedShots(shots, minDurationMs);
}
