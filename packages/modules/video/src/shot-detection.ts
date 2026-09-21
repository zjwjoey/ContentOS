import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DetectedShot = { sourceInMs: number; sourceOutMs: number; confidence: number; evidence: Record<string, unknown> };

export async function detectShotsV1(input: { sourcePath: string; durationMs: number; threshold?: number; ffmpegPath?: string; signal?: AbortSignal }): Promise<DetectedShot[]> {
  const threshold = input.threshold ?? 0.35;
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
  return shots;
}
