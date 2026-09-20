import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { EditManifestV0 } from '../../../contracts/src/index.js';

export interface RenderOptions { manifest: EditManifestV0; outputPath: string; ffmpegPath: string; ffprobePath: string; fontFile?: string; signal?: AbortSignal; }
export interface RenderResult { outputPath: string; durationMs: number; width: number; height: number; format: string; audio: boolean; checksum?: string; }
export interface ProbeResult { format: string; durationMs: number; width: number; height: number; audio: boolean; videoCodec?: string; audioCodec?: string; pixelFormat?: string; fps?: number; }
export interface RepresentativeFrame { index: number; timestampMs: number; path: string; }
export function subtitlePositionExpressions(positionX: number, positionY: number): { x: string; y: string } {
  const x = Math.min(1, Math.max(0, positionX));
  const y = Math.min(1, Math.max(0, positionY));
  return { x: `max(0\\,min(w-text_w\\,w*${x}-text_w/2))`, y: `max(0\\,min(h-text_h\\,h*${y}-text_h/2))` };
}
export function blurBackgroundBranches(canvasWidth: number, canvasHeight: number): { background: string; foreground: string } {
  const background = `scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=increase,crop=${canvasWidth}:${canvasHeight},boxblur=12:2`;
  const foreground = `scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=decrease`;
  return { background, foreground };
}
export async function generateVideoThumbnail(inputPath: string, outputPath: string, ffmpegPath: string, durationMs: number, signal?: AbortSignal): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const seekMs = Math.min(1_000, Math.max(0, Math.round(durationMs * 0.25)));
  const tempOutput = `${outputPath}.${randomUUID()}.part.jpg`;
  try { await run(ffmpegPath, ['-y', '-ss', String(seekMs / 1000), '-i', inputPath, '-frames:v', '1', '-vf', 'scale=320:-2:force_original_aspect_ratio=decrease', '-q:v', '4', tempOutput], signal); await rename(tempOutput, outputPath); } catch (error) { await rm(tempOutput, { force: true }); throw error; }
}

export function representativeFrameTimestamps(durationMs: number): number[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const lastSafeMs = Math.max(0, Math.round(durationMs) - 1);
  return [0.1, 0.3, 0.5, 0.7, 0.9].map((ratio) => Math.min(lastSafeMs, Math.max(0, Math.round(durationMs * ratio))));
}

export async function generateRepresentativeFrames(inputPath: string, outputDirectory: string, durationMs: number, ffmpegPath: string, signal?: AbortSignal): Promise<RepresentativeFrame[]> {
  const timestamps = representativeFrameTimestamps(durationMs);
  await mkdir(outputDirectory, { recursive: true });
  const frames: RepresentativeFrame[] = [];
  for (const [index, timestampMs] of timestamps.entries()) {
    signal?.throwIfAborted();
    const outputPath = join(outputDirectory, `${index}.jpg`);
    if (!await access(outputPath, constants.F_OK).then(() => true).catch(() => false)) {
      const tempOutput = `${outputPath}.${randomUUID()}.part.jpg`;
      try {
        await run(ffmpegPath, ['-y', '-ss', String(timestampMs / 1000), '-i', inputPath, '-frames:v', '1', '-vf', 'scale=640:-2:force_original_aspect_ratio=decrease', '-q:v', '4', tempOutput], signal);
        await rename(tempOutput, outputPath);
      } catch (error) {
        await rm(tempOutput, { force: true });
        throw error;
      }
    }
    frames.push({ index, timestampMs, path: outputPath });
  }
  return frames;
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
  return text.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll(',', '\\,').replaceAll(';', '\\;').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('\n', ' ');
}
function escapeFilterPath(path: string): string { return path.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll(',', '\\,').replaceAll(';', '\\;'); }
function ffmpegColor(value: string): string { return value.startsWith('#') ? `0x${value.slice(1)}` : value; }

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
  const renderFontFile = options.fontFile || manifest.presentationSettings?.subtitleStyle.fontFile || manifest.metadata?.presentationSettings?.subtitleStyle.fontFile;
  if ((manifest.subtitles?.length || manifest.textOverlays?.length) && !renderFontFile) throw new Error('RENDER_SUBTITLE_FONT_UNAVAILABLE');
  if (renderFontFile && (manifest.subtitles?.length || manifest.textOverlays?.length) && !await access(renderFontFile, constants.F_OK).then(() => true).catch(() => false)) throw new Error('RENDER_SUBTITLE_FONT_UNAVAILABLE');
  if (fixture?.generateFixtureInput && fixture.fixturePath) await generateFixtureVideo(fixture.fixturePath, ffmpegPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const tempOutput = `${outputPath}.${randomUUID()}.part.mp4`;
  const overlayDir = renderFontFile && (manifest.subtitles?.length || manifest.textOverlays?.length) ? join(dirname(outputPath), `.text-${randomUUID()}`) : undefined;
  if (overlayDir) { await mkdir(overlayDir, { recursive: true }); const textItems = [...(manifest.subtitles ?? []), ...(manifest.textOverlays ?? [])]; await Promise.all(textItems.map((item, index) => writeFile(join(overlayDir, `${index}.txt`), item.text.replaceAll('\r\n', '\n'), 'utf8'))); }
  const args: string[] = ['-y'];
  for (const clip of manifest.timeline) {
    const sourceDurationMs = clip.sourceOutMs === undefined ? clip.durationMs : clip.sourceOutMs - clip.sourceInMs;
    if (sourceDurationMs <= 0 || sourceDurationMs !== clip.durationMs) throw new Error('RENDER_SOURCE_RANGE_DURATION_MISMATCH');
    args.push('-ss', String(clip.sourceInMs / 1000), '-t', String(sourceDurationMs / 1000), '-i', clip.sourcePath);
  }
  const voiceIndex = manifest.audio.voicePath ? manifest.timeline.length : -1;
  if (manifest.audio.voicePath) args.push('-i', manifest.audio.voicePath);
  const musicIndex = manifest.audio.backgroundMusic?.path ? manifest.timeline.length + (voiceIndex >= 0 ? 1 : 0) : -1;
  if (musicIndex >= 0 && manifest.audio.backgroundMusic?.path) { if (manifest.audio.backgroundMusic.loop !== false) args.push('-stream_loop', '-1'); args.push('-i', manifest.audio.backgroundMusic.path); }
  const filters: string[] = [];
  const outputFps = Math.max(1, Number(manifest.canvas.fps || 30));
  const canvasWidth = Math.max(2, Number(manifest.canvas.width || 1080));
  const canvasHeight = Math.max(2, Number(manifest.canvas.height || 1920));
  const fitMode = manifest.canvas.fitMode || manifest.presentationSettings?.canvas.fitMode || manifest.metadata?.presentationSettings?.canvas.fitMode || 'FILL';
  const visualDurations = manifest.timeline.map((clip) => clip.timelineStartMs !== undefined && clip.timelineEndMs !== undefined ? Math.max(clip.durationMs, clip.timelineEndMs - clip.timelineStartMs) : clip.durationMs);
  let visualCursorMs = 0;
  const firstStart = manifest.timeline[0]?.timelineStartMs ?? 0;
  if (visualDurations.length > 0) {
    if (firstStart > 0) visualDurations[0] = visualDurations[0]! + firstStart;
    visualCursorMs = firstStart + visualDurations[0]!;
  }
  for (let index = 1; index < manifest.timeline.length; index += 1) {
    const start = manifest.timeline[index]!.timelineStartMs;
    if (start !== undefined && start > visualCursorMs) {
      visualDurations[index - 1] = Math.max(visualDurations[index - 1]!, visualDurations[index - 1]! + (start - visualCursorMs));
      visualCursorMs = start;
    }
    visualCursorMs += visualDurations[index]!;
  }
  let globalOffsetMs = 0;
  for (let i = 0; i < manifest.timeline.length; i += 1) {
    const clip = manifest.timeline[i]!;
    const visualDurationMs = visualDurations[i]!;
    const padMs = Math.max(0, visualDurationMs - clip.durationMs);
    let overlays = '';
    if (renderFontFile) {
      const localStart = globalOffsetMs;
      const draw = (item: { text: string; startMs: number; endMs: number; style?: string; fontSize?: number; position?: string }, kind: 'subtitle' | 'hero', fileIndex: number) => {
        const textFile = overlayDir ? join(overlayDir, `${fileIndex}.txt`) : undefined;
        const start = Math.max(0, (item.startMs - localStart) / 1000); const end = Math.max(start + 0.001, (item.endMs - localStart) / 1000);
        if (end <= 0 || start >= visualDurationMs / 1000) return '';
        const presentation = manifest.subtitleStyle || manifest.presentationSettings?.subtitleStyle || manifest.metadata?.presentationSettings?.subtitleStyle;
        if (presentation && !presentation.enabled) return '';
        const baseScale = canvasWidth / 1080;
        const anchored = presentation ? subtitlePositionExpressions(presentation.position.x, presentation.position.y) : undefined;
        const x = anchored?.x || '(w-text_w)/2';
        const y = anchored?.y || (item.position === 'top' ? '180' : item.position === 'center' ? '(h-text_h)/2' : 'h-220');
        const color = presentation?.color ? presentation.color.replace('#', '0x') : (kind === 'hero' || item.style === 'emphasis' ? 'white' : item.style === 'commercial' ? '0xEAF4FF' : 'white');
        const size = Math.max(1, Math.round((presentation?.fontSize ?? item.fontSize ?? (kind === 'hero' ? 64 : 48)) * baseScale));
        const outline = presentation?.outline.enabled ? `:borderw=${Math.max(1, Math.round(presentation.outline.width * baseScale))}:bordercolor=${ffmpegColor(presentation.outline.color)}` : (item.style === 'commercial' || kind === 'hero' ? `:borderw=${Math.max(1, Math.round(2 * baseScale))}:bordercolor=black@0.75` : '');
        const shadowX = presentation?.shadow.offsetX ?? presentation?.shadow.x ?? 2; const shadowY = presentation?.shadow.offsetY ?? presentation?.shadow.y ?? 2;
        const shadow = presentation?.shadow.enabled ? `:shadowx=${Math.round(shadowX * baseScale)}:shadowy=${Math.round(shadowY * baseScale)}:shadowcolor=${ffmpegColor(presentation.shadow.color)}@${presentation.shadow.opacity ?? .5}` : '';
        const background = presentation?.background.enabled ? `:box=1:boxcolor=${ffmpegColor(presentation.background.color)}@${presentation.background.opacity}:boxborderw=${Math.round(presentation.background.padding * baseScale)}` : (item.style === 'simple' ? '' : `:box=1:boxcolor=black@0.45:boxborderw=${Math.round(12 * baseScale)}`);
        const animation = presentation?.animation || 'NONE';
        const animationDuration = Math.min((end - start) / 2, Math.max(.05, (presentation?.animationDurationMs ?? 250) / 1000));
        const animationExpr = animation === 'SLIDE_UP' ? `:y='max(0\\,min(h-text_h\\,${y}+if(lt(t-${start}\\,${animationDuration.toFixed(3)})\\,${Math.round(40 * baseScale)}*(1-(t-${start})/${animationDuration.toFixed(3)})\\,0)))'` : '';
        const textSource = textFile ? `textfile='${escapeFilterPath(textFile)}':expansion=none` : `text='${escapeFilterText(item.text)}'`;
        const fade = animation === 'FADE_IN' ? `:alpha='if(lt(t-${start},${animationDuration.toFixed(3)}),(t-${start})/${animationDuration.toFixed(3)},1)'` : animation === 'FADE_OUT' ? `:alpha='if(gt(${end}-t,${animationDuration.toFixed(3)}),1,(${end}-t)/${animationDuration.toFixed(3)})'` : animation === 'FADE_IN_OUT' ? `:alpha='if(lt(t-${start},${animationDuration.toFixed(3)}),(t-${start})/${animationDuration.toFixed(3)},if(gt(${end}-t,${animationDuration.toFixed(3)}),1,(${end}-t)/${animationDuration.toFixed(3)}))'` : '';
        return `,drawtext=fontfile='${escapeFilterPath(renderFontFile)}':${textSource}:fontcolor=${color}:fontsize=${size}:x=${x}:y=${y}${outline}${shadow}${background}${animationExpr}${fade}:enable='between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})'`;
      };
      for (const [index, item] of (manifest.subtitles ?? []).entries()) overlays += draw(item, 'subtitle', index);
      const subtitleCount = manifest.subtitles?.length ?? 0;
      for (const [index, item] of (manifest.textOverlays ?? []).entries()) overlays += draw(item, 'hero', subtitleCount + index);
    }
    const pad = padMs > 0 ? `,tpad=stop_mode=clone:stop_duration=${padMs / 1000}` : '';
    const clipDurationSeconds = Math.max(0.001, clip.durationMs / 1000).toFixed(6);
    const fill = `scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=increase,crop=${canvasWidth}:${canvasHeight}`;
    const contain = blurBackgroundBranches(canvasWidth, canvasHeight).foreground;
    const containWithPad = `${contain},pad=${canvasWidth}:${canvasHeight}:(ow-iw)/2:(oh-ih)/2:color=black`;
    const normalized = fitMode === 'CONTAIN' ? containWithPad : fill;
    if (fitMode === 'BLUR_BACKGROUND') {
      const branches = blurBackgroundBranches(canvasWidth, canvasHeight);
      filters.push(`[${i}:v]split=2[bg${i}][fg${i}];[bg${i}]${branches.background}[bgf${i}];[fg${i}]${branches.foreground}[fgf${i}];[bgf${i}][fgf${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p,fps=${outputFps}:round=up,trim=duration=${clipDurationSeconds},setpts=PTS-STARTPTS${overlays}${pad},fps=${outputFps}:round=up,setpts=PTS-STARTPTS[v${i}]`);
    } else {
      filters.push(`[${i}:v]${normalized},setsar=1,format=yuv420p,fps=${outputFps}:round=up,trim=duration=${clipDurationSeconds},setpts=PTS-STARTPTS${overlays}${pad},fps=${outputFps}:round=up,setpts=PTS-STARTPTS[v${i}]`);
    }
    globalOffsetMs += visualDurationMs;
  }
  if (manifest.timeline.length === 1) filters.push('[v0]null[vout]');
  else filters.push(`${manifest.timeline.map((_, i) => `[v${i}]`).join('')}concat=n=${manifest.timeline.length}:v=1:a=0[vout]`);
  const videoDurationMs = visualDurations.reduce((total, duration) => total + duration, 0);
  if (voiceIndex >= 0) {
    const offsetMs = Math.max(0, Number(manifest.metadata?.audioOffsetMs || 0));
    filters.push(`[${voiceIndex}:a]adelay=${offsetMs}:all=1,volume=${manifest.audio.volume ?? 1},apad[voice]`);
  }
  const audioArgs: string[] = [];
  if (musicIndex >= 0) {
    const musicVolume = manifest.audio.backgroundMusic?.ducking?.musicVolume ?? manifest.audio.backgroundMusic?.volume ?? 0.12;
    filters.push(`[${musicIndex}:a]volume=${musicVolume},atrim=duration=${(videoDurationMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS[music]`);
    if (voiceIndex >= 0) filters.push(`[voice][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
    else filters.push('[music]apad[aout]');
    audioArgs.push('-map', '[aout]', '-c:a', 'aac', '-strict', '-2', '-t', String(videoDurationMs / 1000));
  } else if (voiceIndex >= 0) audioArgs.push('-map', '[voice]', '-c:a', 'aac', '-strict', '-2', '-t', String(videoDurationMs / 1000));
  else audioArgs.push('-an');
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', ...audioArgs);
  const videoEncoder = manifest.output.videoCodec === 'h264' ? 'libx264' : 'mpeg4';
  args.push('-c:v', videoEncoder, '-pix_fmt', 'yuv420p', '-r', String(outputFps));
  if (videoEncoder === 'libx264') args.push('-crf', '23');
  args.push('-movflags', '+faststart', tempOutput);
  try {
    await run(ffmpegPath, args, options.signal);
    const probe = await probeMedia(tempOutput, ffprobePath, options.signal);
    const requiresAudio = Boolean(manifest.audio.voicePath || manifest.audio.backgroundMusic?.path);
    const codecValid = probe.videoCodec === manifest.output.videoCodec && (!requiresAudio || probe.audioCodec === manifest.output.audioCodec);
    if (probe.format !== 'mp4' || probe.width !== canvasWidth || probe.height !== canvasHeight || probe.durationMs <= 0 || (requiresAudio && !probe.audio) || !codecValid) throw new Error(`Rendered output failed MP4/${canvasWidth}x${canvasHeight}/codec validation: ${JSON.stringify(probe)}`);
    await rename(tempOutput, outputPath);
    if (overlayDir) await rm(overlayDir, { recursive: true, force: true });
    return { outputPath, ...probe };
  } catch (error) { await rm(tempOutput, { force: true }); if (overlayDir) await rm(overlayDir, { recursive: true, force: true }); throw error; }
}
