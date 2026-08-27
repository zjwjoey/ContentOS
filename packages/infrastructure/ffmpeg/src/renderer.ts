import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import type { EditManifestV0 } from '../../../contracts/src/index.js';

export interface RenderOptions { manifest: EditManifestV0; outputPath: string; ffmpegPath: string; ffprobePath: string; fontFile?: string; signal?: AbortSignal; }
export interface RenderResult { outputPath: string; durationMs: number; width: number; height: number; format: string; audio: boolean; checksum?: string; }
export interface ProbeResult { format: string; durationMs: number; width: number; height: number; audio: boolean; }

function run(binary: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(binary, args, signal ? { windowsHide: true, signal } : { windowsHide: true });
    let stdout = ''; let stderr = '';
    let processError: Error | null = null;
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { processError = error; });
    child.on('close', (code) => processError ? reject(processError) : code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-1200)}`)));
  });
}

function escapeFilterText(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'").replaceAll(',', '\\,').replaceAll('\n', ' ');
}

export async function generateFixtureVideo(path: string, ffmpegPath: string, color?: string): Promise<void> {
  const input = color ? `color=c=${color}:size=640x360:rate=30` : 'testsrc=size=640x360:rate=30';
  await run(ffmpegPath, ['-y', '-f', 'lavfi', '-i', input, '-t', '2', '-pix_fmt', 'yuv420p', '-an', path]);
}

export async function generateFixtureAudio(path: string, ffmpegPath: string): Promise<void> {
  await run(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '5', '-c:a', 'pcm_s16le', path]);
}

export async function probeMedia(path: string, ffprobePath: string, signal?: AbortSignal): Promise<ProbeResult> {
  const result = await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=width,height,codec_type', '-of', 'json', path], signal);
  const parsed = JSON.parse(result.stdout) as { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audio = Boolean(parsed.streams?.some((stream) => stream.codec_type === 'audio'));
  const formats = parsed.format?.format_name || '';
  return { format: formats.includes('mp4') ? 'mp4' : (formats.split(',')[0] || 'unknown'), durationMs: Math.round(Number(parsed.format?.duration || 0) * 1000), width: Number(video?.width || 0), height: Number(video?.height || 0), audio };
}

export async function renderEditManifest(options: RenderOptions, fixture?: { generateFixtureInput?: boolean; fixturePath?: string }): Promise<RenderResult> {
  const { manifest, outputPath, ffmpegPath, ffprobePath } = options;
  options.signal?.throwIfAborted();
  if (fixture?.generateFixtureInput && fixture.fixturePath) await generateFixtureVideo(fixture.fixturePath, ffmpegPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const tempOutput = `${outputPath}.${randomUUID()}.part.mp4`;
  const args: string[] = ['-y'];
  for (const clip of manifest.timeline) args.push('-ss', String(clip.sourceInMs / 1000), '-t', String(clip.durationMs / 1000), '-i', clip.sourcePath);
  const voiceIndex = manifest.audio.voicePath ? manifest.timeline.length : -1;
  if (manifest.audio.voicePath) args.push('-i', manifest.audio.voicePath);
  const filters: string[] = [];
  for (let i = 0; i < manifest.timeline.length; i += 1) {
    const clip = manifest.timeline[i]!;
    const subtitle = i === 0 && manifest.subtitles?.[0] && options.fontFile ? `,drawtext=fontfile='${escapeFilterText(options.fontFile)}':text='${escapeFilterText(manifest.subtitles[0].text)}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=h-180:box=1:boxcolor=black@0.45` : '';
    filters.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p${subtitle},setpts=PTS-STARTPTS[v${i}]`);
  }
  if (manifest.timeline.length === 1) filters.push('[v0]null[vout]');
  else filters.push(`${manifest.timeline.map((_, i) => `[v${i}]`).join('')}concat=n=${manifest.timeline.length}:v=1:a=0[vout]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
  if (voiceIndex >= 0) args.push('-map', `${voiceIndex}:a?`, '-c:a', 'aac', '-strict', '-2', '-shortest'); else args.push('-an');
  args.push('-c:v', 'mpeg4', '-q:v', '5', '-movflags', '+faststart', tempOutput);
  try {
    await run(ffmpegPath, args, options.signal);
    const probe = await probeMedia(tempOutput, ffprobePath, options.signal);
    if (probe.format !== 'mp4' || probe.width !== 1080 || probe.height !== 1920 || probe.durationMs <= 0 || (manifest.audio.voicePath && !probe.audio)) throw new Error(`Rendered output failed MP4/1080x1920 validation: ${JSON.stringify(probe)}`);
    await rename(tempOutput, outputPath);
    return { outputPath, ...probe };
  } catch (error) { await rm(tempOutput, { force: true }); throw error; }
}
