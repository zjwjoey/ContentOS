import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import type { EditManifestV0 } from '../../../contracts/src/index.js';

export interface RenderOptions { manifest: EditManifestV0; outputPath: string; ffmpegPath: string; ffprobePath: string; fontFile?: string; signal?: AbortSignal; }
export interface RenderResult { outputPath: string; durationMs: number; width: number; height: number; format: string; audio: boolean; checksum?: string; }
export interface ProbeResult { format: string; durationMs: number; width: number; height: number; audio: boolean; videoCodec?: string; audioCodec?: string; pixelFormat?: string; fps?: number; }
export async function generateVideoThumbnail(inputPath: string, outputPath: string, ffmpegPath: string, durationMs: number, signal?: AbortSignal): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const seekMs = Math.min(1_000, Math.max(0, Math.round(durationMs * 0.25)));
  const tempOutput = `${outputPath}.${randomUUID()}.part.jpg`;
  try { await run(ffmpegPath, ['-y', '-ss', String(seekMs / 1000), '-i', inputPath, '-frames:v', '1', '-vf', 'scale=320:-2:force_original_aspect_ratio=decrease', '-q:v', '4', tempOutput], signal); await rename(tempOutput, outputPath); } catch (error) { await rm(tempOutput, { force: true }); throw error; }
}

function run(binary: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const execute = (executable: string): Promise<{ stdout: string; stderr: string }> => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, args, signal ? { windowsHide: true, signal } : { windowsHide: true });
    let stdout = ''; let stderr = '';
    let processError: Error | null = null;
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { processError = error; });
    child.on('close', (code) => processError ? reject(processError) : code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-1200)}`)));
  });
  return execute(binary).catch((error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : undefined;
    if (process.platform !== 'win32' || code !== 'ENOENT' || !binary.includes('\\')) throw error;
    return execute(basename(binary));
  });
}

function escapeFilterText(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'").replaceAll(',', '\\,').replaceAll('\n', ' ');
}

export async function generateFixtureVideo(path: string, ffmpegPath: string, color?: string, durationSeconds = 2): Promise<void> {
  const input = color ? `color=c=${color}:size=640x360:rate=30` : 'testsrc=size=640x360:rate=30';
  await run(ffmpegPath, ['-y', '-f', 'lavfi', '-i', input, '-t', String(durationSeconds), '-pix_fmt', 'yuv420p', '-an', path]);
}

export async function generateFixtureAudio(path: string, ffmpegPath: string): Promise<void> {
  await run(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '5', '-c:a', 'pcm_s16le', path]);
}

export async function probeMedia(path: string, ffprobePath: string, signal?: AbortSignal): Promise<ProbeResult> {
  const result = await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=width,height,codec_type,codec_name,pix_fmt,r_frame_rate', '-of', 'json', path], signal);
  const parsed = JSON.parse(result.stdout) as { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; r_frame_rate?: string }> };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audioStream = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const audio = Boolean(audioStream);
  const formats = parsed.format?.format_name || '';
  const fpsParts = String(video?.r_frame_rate || '').split('/');
  const fpsNumerator = Number(fpsParts[0]); const fpsDenominator = Number(fpsParts[1]);
  const fps = Number.isFinite(fpsNumerator) && Number.isFinite(fpsDenominator) && fpsDenominator > 0 ? fpsNumerator / fpsDenominator : undefined;
  return { format: formats.includes('mp4') ? 'mp4' : (formats.split(',')[0] || 'unknown'), durationMs: Math.round(Number(parsed.format?.duration || 0) * 1000), width: Number(video?.width || 0), height: Number(video?.height || 0), audio, ...(video?.codec_name ? { videoCodec: video.codec_name } : {}), ...(audioStream?.codec_name ? { audioCodec: audioStream.codec_name } : {}), ...(video?.pix_fmt ? { pixelFormat: video.pix_fmt } : {}), ...(fps !== undefined ? { fps } : {}) };
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
  const musicIndex = manifest.audio.backgroundMusic?.path ? manifest.timeline.length + (voiceIndex >= 0 ? 1 : 0) : -1;
  if (musicIndex >= 0 && manifest.audio.backgroundMusic?.path) args.push('-stream_loop', '-1', '-i', manifest.audio.backgroundMusic.path);
  const filters: string[] = [];
  const outputFps = Math.max(1, Number(manifest.canvas.fps || 30));
  let globalOffsetMs = 0;
  for (let i = 0; i < manifest.timeline.length; i += 1) {
    const clip = manifest.timeline[i]!;
    const visualDurationMs = clip.timelineStartMs !== undefined && clip.timelineEndMs !== undefined ? Math.max(clip.durationMs, clip.timelineEndMs - clip.timelineStartMs) : clip.durationMs;
    const padMs = Math.max(0, visualDurationMs - clip.durationMs);
    let overlays = '';
    if (options.fontFile) {
      const localStart = globalOffsetMs;
      const draw = (item: { text: string; startMs: number; endMs: number; style?: string; fontSize?: number; position?: string }, kind: 'subtitle' | 'hero') => {
        const start = Math.max(0, (item.startMs - localStart) / 1000); const end = Math.max(start + 0.001, (item.endMs - localStart) / 1000);
        if (end <= 0 || start >= visualDurationMs / 1000) return '';
        const y = item.position === 'top' ? '180' : item.position === 'center' ? '(h-text_h)/2' : 'h-220';
        const color = kind === 'hero' || item.style === 'emphasis' ? 'white' : item.style === 'commercial' ? '0xEAF4FF' : 'white';
        const size = item.fontSize ?? (kind === 'hero' ? 64 : 48);
        return `,drawtext=fontfile='${escapeFilterText(options.fontFile!)}':text='${escapeFilterText(item.text)}':fontcolor=${color}:fontsize=${size}:x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.45:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
      };
      for (const item of manifest.subtitles ?? []) overlays += draw(item, 'subtitle');
      for (const item of manifest.textOverlays ?? []) overlays += draw(item, 'hero');
    }
    const pad = padMs > 0 ? `,tpad=stop_mode=clone:stop_duration=${padMs / 1000}` : '';
    const clipDurationSeconds = Math.max(0.001, clip.durationMs / 1000).toFixed(6);
    filters.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p,fps=${outputFps}:round=up,trim=duration=${clipDurationSeconds},setpts=PTS-STARTPTS${overlays}${pad},fps=${outputFps}:round=up,setpts=PTS-STARTPTS[v${i}]`);
    globalOffsetMs += visualDurationMs;
  }
  if (manifest.timeline.length === 1) filters.push('[v0]null[vout]');
  else filters.push(`${manifest.timeline.map((_, i) => `[v${i}]`).join('')}concat=n=${manifest.timeline.length}:v=1:a=0[vout]`);
  const videoDurationMs = manifest.timeline.reduce((total, clip) => { const visual = clip.timelineStartMs !== undefined && clip.timelineEndMs !== undefined ? Math.max(clip.durationMs, clip.timelineEndMs - clip.timelineStartMs) : clip.durationMs; return total + visual; }, 0);
  if (voiceIndex >= 0) {
    const offsetMs = Math.max(0, Number(manifest.metadata?.audioOffsetMs || 0));
    filters.push(`[${voiceIndex}:a]adelay=${offsetMs}:all=1,volume=${manifest.audio.volume ?? 1},apad[voice]`);
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
  if (musicIndex >= 0) {
    const musicVolume = manifest.audio.backgroundMusic?.ducking?.musicVolume ?? manifest.audio.backgroundMusic?.volume ?? 0.12;
    filters.push(`[${musicIndex}:a]volume=${musicVolume},atrim=duration=${(videoDurationMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS[music]`);
    if (voiceIndex >= 0) filters.push(`[voice][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
    else filters.push('[music]apad[aout]');
    // filter_complex was appended above; replace it with the complete filter graph.
    args[args.indexOf('-filter_complex') + 1] = filters.join(';');
    args.push('-map', '[aout]', '-c:a', 'aac', '-strict', '-2', '-t', String(videoDurationMs / 1000));
  } else if (voiceIndex >= 0) args.push('-map', '[voice]', '-c:a', 'aac', '-strict', '-2', '-t', String(videoDurationMs / 1000));
  else args.push('-an');
  const videoEncoder = manifest.output.videoCodec === 'h264' ? 'libx264' : 'mpeg4';
  args.push('-c:v', videoEncoder, '-pix_fmt', 'yuv420p', '-r', String(outputFps));
  if (videoEncoder === 'libx264') args.push('-crf', '23');
  args.push('-movflags', '+faststart', tempOutput);
  try {
    await run(ffmpegPath, args, options.signal);
    const probe = await probeMedia(tempOutput, ffprobePath, options.signal);
    const codecValid = probe.videoCodec === manifest.output.videoCodec && (!manifest.audio.voicePath || probe.audioCodec === manifest.output.audioCodec);
    if (probe.format !== 'mp4' || probe.width !== 1080 || probe.height !== 1920 || probe.durationMs <= 0 || (manifest.audio.voicePath && !probe.audio) || !codecValid) throw new Error(`Rendered output failed MP4/1080x1920/codec validation: ${JSON.stringify(probe)}`);
    await rename(tempOutput, outputPath);
    return { outputPath, ...probe };
  } catch (error) { await rm(tempOutput, { force: true }); throw error; }
}
