const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const TARGET = { width: 1080, height: 1920, fps: 30 };
let activeProcesses = new Set();

function exec(command, args, { interruptAfterMs = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    activeProcesses.add(child);
    let stderr = '';
    let stdout = '';
    let interrupted = false;
    const timer = interruptAfterMs === null ? null : setTimeout(() => {
      interrupted = true;
      child.kill('SIGKILL');
    }, interruptAfterMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      activeProcesses.delete(child);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}`, interrupted });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      activeProcesses.delete(child);
      resolve({ code: code ?? -1, signal, stdout, stderr, interrupted });
    });
  });
}

async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true });
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

function fixtureName(index) {
  return index === 9 ? '素材-中文-10.mp4' : `fixture-${String(index + 1).padStart(2, '0')}.mp4`;
}

async function generateFixturesLegacy(fixturesDir) {
  await ensureDir(fixturesDir);
  const specs = [
    [1280, 720, 24, 3.4, '0x214e6b'],
    [720, 1280, 30, 3.6, '0x8f2d56'],
    [640, 360, 25, 3.8, '0x2f6f4e'],
    [1920, 1080, 30, 4.0, '0xb85c00'],
    [1080, 1920, 24, 4.2, '0x5b3f8c'],
    [854, 480, 29.97, 4.4, '0x276749'],
    [480, 854, 15, 4.6, '0x7b341e'],
    [1024, 576, 25, 4.8, '0x285e61'],
    [720, 720, 30, 5.0, '0x744210'],
    [1920, 1080, 24, 5.2, '0x44337a'],
  ];
  for (let i = 0; i < specs.length; i += 1) {
    const [width, height, fps, duration, color] = specs[i];
    const output = path.join(fixturesDir, fixtureName(i));
    if (!(await exists(output))) {
      const result = await exec(FFMPEG, [
        '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:r=${fps}:d=${duration}`,
        '-an', '-r', String(fps), '-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p', output,
      ]);
      if (result.code !== 0) throw new Error(`fixture generation failed for ${output}: ${result.stderr}`);
    }
  }
  const voice = path.join(fixturesDir, 'voice.wav');
  if (!(await exists(voice))) {
    const result = await exec(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=30', '-c:a', 'pcm_s16le', voice]);
    if (result.code !== 0) throw new Error(`voice generation failed: ${result.stderr}`);
  }
  const subtitles = path.join(fixturesDir, '中文字幕.srt');
  if (!(await exists(subtitles))) {
    await fs.writeFile(subtitles, [
      '1', '00:00:00,000 --> 00:00:05,000', '内容矩阵生产中控台 Spike 02', '',
      '2', '00:00:05,000 --> 00:00:10,000', '中文字体与 UTF-8 字幕验证', '',
      '3', '00:00:10,000 --> 00:00:15,000', '固定 Manifest 驱动渲染', '',
      '4', '00:00:15,000 --> 00:00:20,000', '横屏素材转为竖屏输出', '',
      '5', '00:00:20,000 --> 00:00:25,000', '随机种子保证可复现', '',
      '6', '00:00:25,000 --> 00:00:30,000', 'Spike 02 验证完成', '',
    ].join('\r\n'), 'utf8');
  }
  return { videos: specs.map((_, index) => fixtureName(index)), voice: 'voice.wav', subtitles: '中文字幕.srt' };
}

const SUBTITLE_NAME = '\u4e2d\u6587\u5b57\u5e55.srt';
const SUBTITLE_LINES = [
  { start: 0, end: 5, text: '\u5185\u5bb9\u77e9\u9635\u751f\u4ea7\u4e2d\u63a7\u53f0 Spike 02' },
  { start: 5, end: 10, text: '\u4e2d\u6587\u5b57\u4f53\u4e0e UTF-8 \u5b57\u5e55\u9a8c\u8bc1' },
  { start: 10, end: 15, text: '\u56fa\u5b9a Manifest \u9a71\u52a8\u6e32\u67d3' },
  { start: 15, end: 20, text: '\u6a2a\u5c4f\u7d20\u6750\u8f6c\u4e3a\u7ad6\u5c4f\u8f93\u51fa' },
  { start: 20, end: 25, text: '\u968f\u673a\u79cd\u5b50\u4fdd\u8bc1\u53ef\u590d\u73b0' },
  { start: 25, end: 30, text: 'Spike 02 \u9a8c\u8bc1\u5b8c\u6210' },
];

async function generateFixtures(fixturesDir) {
  const legacy = await generateFixturesLegacy(fixturesDir);
  const chineseVideo = path.join(fixturesDir, '\u7d20\u6750-\u4e2d\u6587-10.mp4');
  if (!(await exists(chineseVideo))) await fs.copyFile(path.join(fixturesDir, legacy.videos[9]), chineseVideo);
  const subtitles = path.join(fixturesDir, SUBTITLE_NAME);
  if (!(await exists(subtitles))) {
    const timestamp = (seconds) => `00:00:${String(seconds).padStart(2, '0')},000`;
    const srt = SUBTITLE_LINES.flatMap((line, index) => [
      String(index + 1), `${timestamp(line.start)} --> ${timestamp(line.end)}`, line.text, '',
    ]).join('\r\n');
    await fs.writeFile(subtitles, srt, 'utf8');
  }
  return { ...legacy, videos: [...legacy.videos.slice(0, 9), '\u7d20\u6750-\u4e2d\u6587-10.mp4'], subtitles: SUBTITLE_NAME };
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function shuffle(items, random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function createManifest({ fixtureDir, voiceDuration = 30, randomSeed = 1 }) {
  const generated = await generateFixtures(fixtureDir);
  const random = seededRandom(randomSeed);
  const ordered = shuffle(generated.videos, random);
  const clipDurationMs = Math.floor((voiceDuration * 1000) / ordered.length);
  const clips = ordered.map((sourceRef, index) => ({
    id: `clip-${String(index + 1).padStart(2, '0')}`,
    sourceRef,
    sourceInMs: Math.floor(random() * 300),
    sourceOutMs: Math.floor(random() * 300) + clipDurationMs,
    startMs: index * clipDurationMs,
    endMs: (index + 1) * clipDurationMs,
    operations: [{ type: index === 0 ? 'fade_in' : 'fade', durationMs: 400 }],
  }));
  return {
    schemaVersion: 'EDIT_MANIFEST_V0',
    manifestId: `manifest-${randomSeed}`,
    revision: 1,
    projectId: 'spike-02-project',
    target: { ...TARGET },
    sources: [
      ...generated.videos.map((fileName) => ({ assetId: fileName, fileName, checksum: 'fixture-generated' })),
      { assetId: generated.voice, fileName: generated.voice, checksum: 'fixture-generated' },
      { assetId: generated.subtitles, fileName: generated.subtitles, checksum: 'fixture-generated' },
    ],
    timeline: {
      video: clips,
      audio: [{ sourceRef: generated.voice, startMs: 0, endMs: voiceDuration * 1000 }],
      captions: [{ sourceRef: generated.subtitles, startMs: 0, endMs: voiceDuration * 1000 }],
    },
    output: {
      container: 'mp4',
      expectedDurationRangeMs: { min: voiceDuration * 1000 - 500, max: voiceDuration * 1000 + 500 },
    },
    provenance: { planner: 'spike-02-seeded-planner', randomSeed },
  };
}

function validateManifest(manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== 'EDIT_MANIFEST_V0') errors.push({ field: 'schemaVersion', code: 'UNSUPPORTED_SCHEMA' });
  const clips = manifest?.timeline?.video || [];
  clips.forEach((clip, index) => {
    if (!(clip.sourceOutMs > clip.sourceInMs)) errors.push({ field: `timeline.video[${index}].sourceOutMs`, code: 'INVALID_RANGE' });
    if (!(clip.endMs > clip.startMs)) errors.push({ field: `timeline.video[${index}].endMs`, code: 'INVALID_RANGE' });
  });
  if (manifest?.target?.width !== 1080 || manifest?.target?.height !== 1920) errors.push({ field: 'target', code: 'TARGET_MISMATCH' });
  return errors.length ? { valid: false, errors } : { valid: true, errors: [] };
}

function filterPath(filePath) {
  return filePath.replaceAll('\\', '/').replace(':', '\\:').replaceAll("'", "\\'");
}

function filterText(text) {
  return text.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'").replaceAll('%', '\\%');
}

function buildSubtitleDrawtext(subtitlesPath) {
  let lines = SUBTITLE_LINES;
  try {
    const source = require('node:fs').readFileSync(subtitlesPath, 'utf8');
    const parsed = source.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
      const rows = block.split(/\r?\n/);
      const match = rows[1]?.match(/00:00:(\d\d),\d+ --> 00:00:(\d\d),\d+/);
      return match ? { start: Number(match[1]), end: Number(match[2]), text: rows.slice(2).join(' ') } : null;
    }).filter(Boolean);
    if (parsed.length) lines = parsed;
  } catch { /* deterministic fallback */ }
  const fontFile = filterPath('C:/Windows/Fonts/msyh.ttc');
  return lines.map((line) => (
    `drawtext=fontfile='${fontFile}':text='${filterText(line.text)}':fontcolor=white:fontsize=44:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-180:enable='between(t,${line.start},${line.end})'`
  )).join(',');
}

function buildFfmpegCommand({ manifest, fixtureDir, outputPath, subtitlesPath }) {
  const inputs = manifest.timeline.video.map((clip) => path.join(fixtureDir, clip.sourceRef));
  const voiceRef = manifest.timeline.audio[0].sourceRef;
  inputs.push(path.join(fixtureDir, voiceRef));
  const videoFilters = [];
  const labels = [];
  const fadeDuration = 0.4;
  manifest.timeline.video.forEach((clip, index) => {
    const input = `[${index}:v]`;
    const duration = (clip.endMs - clip.startMs) / 1000;
    const start = clip.sourceInMs / 1000;
    const fadeOutStart = Math.max(duration - fadeDuration, 0);
    const label = `v${index}`;
    videoFilters.push(`${input}trim=start=${start.toFixed(3)}:duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,scale=${TARGET.width}:${TARGET.height}:force_original_aspect_ratio=increase,crop=${TARGET.width}:${TARGET.height},setsar=1,fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeDuration}[${label}]`);
    labels.push(`[${label}]`);
  });
  videoFilters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[vcat]`);
  if (subtitlesPath) videoFilters.push(`[vcat]${buildSubtitleDrawtext(subtitlesPath)}[vout]`);
  else videoFilters.push('[vcat]null[vout]');
  const args = ['-y'];
  inputs.forEach((input) => args.push('-i', input));
  args.push('-filter_complex', videoFilters.join(';'), '-map', '[vout]', '-map', `${inputs.length - 1}:a:0`, '-t', String(manifest.output.expectedDurationRangeMs.max / 1000), '-r', String(TARGET.fps), '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac', '-strict', '-2', '-b:a', '128k', '-movflags', '+faststart', outputPath);
  return { args, inputs, filterComplex: videoFilters.join(';') };
}

async function renderManifest({ manifest, fixtureDir, outputPath, subtitlesPath, interruptAfterMs = null }) {
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    return { status: 'FAILED', error: { code: 'MANIFEST_INVALID', message: 'Edit Manifest validation failed', details: validation.errors } };
  }
  await ensureDir(path.dirname(outputPath));
  const extension = path.extname(outputPath) || '.mp4';
  const tempPath = `${outputPath.slice(0, outputPath.length - extension.length)}.part-${crypto.randomUUID()}${extension}`;
  const effectiveSubtitlesPath = subtitlesPath ? path.join(fixtureDir, SUBTITLE_NAME) : null;
  const command = buildFfmpegCommand({ manifest, fixtureDir, outputPath: tempPath, subtitlesPath: effectiveSubtitlesPath });
  const result = await exec(FFMPEG, command.args, { interruptAfterMs });
  if (result.interrupted) {
    await fs.rm(tempPath, { force: true });
    return { status: 'FAILED', error: { code: 'RENDER_INTERRUPTED', message: 'FFmpeg process was interrupted' }, command: [FFMPEG, ...command.args].join(' ') };
  }
  if (result.code !== 0) {
    await fs.rm(tempPath, { force: true });
    return { status: 'FAILED', error: { code: 'FFMPEG_FAILED', message: 'FFmpeg returned a non-zero exit code', details: result.stderr.slice(-4000) }, command: [FFMPEG, ...command.args].join(' ') };
  }
  await fs.rename(tempPath, outputPath);
  return { status: 'SUCCEEDED', outputPath, command: [FFMPEG, ...command.args].join(' '), stderr: result.stderr.slice(-2000) };
}

async function probeMedia(filePath) {
  const result = await exec(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', filePath]);
  if (result.code !== 0) throw new Error(`ffprobe failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const stream = parsed.streams?.find((entry) => entry.width && entry.height) || {};
  return { width: Number(stream.width), height: Number(stream.height), duration: Number(parsed.format?.duration) };
}

async function closeRenderer() {
  for (const child of activeProcesses) child.kill('SIGKILL');
  activeProcesses.clear();
}

module.exports = { generateFixtures, createManifest, validateManifest, renderManifest, probeMedia, buildFfmpegCommand, closeRenderer };
