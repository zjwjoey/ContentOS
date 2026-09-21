import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { generateFixtureVideo, generateRepresentativeFrames, probeMedia } from '../packages/infrastructure/ffmpeg/src/index.js';
import { InMemoryMaterialSemanticIndex } from '../packages/modules/video/src/index.js';
import type { MaterialPoolItemV3 } from '../packages/contracts/src/index.js';

const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm']);
const requiredVideoCount = 100;

async function collectVideos(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectVideos(path));
    else if (entry.isFile() && videoExtensions.has(extname(entry.name).toLowerCase())) files.push(path);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!;
}

function elapsed(start: number): number { return Math.round((performance.now() - start) * 100) / 100; }

async function main(): Promise<void> {
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
  const configuredRoot = process.env.CONTENTOS_V3_BENCHMARK_MEDIA_ROOT || process.argv[2];
  const generatedRoot = configuredRoot ? undefined : await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'contentos-v3-benchmark-'));
  const mediaRoot = resolve(configuredRoot || generatedRoot!);
  let generated = false;
  try {
    const scanStart = performance.now();
    let paths = await collectVideos(mediaRoot);
    const materialScanMs = elapsed(scanStart);
    if (paths.length < requiredVideoCount && generatedRoot) {
      generated = true;
      for (let index = paths.length; index < requiredVideoCount; index += 1) {
        const path = join(mediaRoot, `benchmark-${String(index + 1).padStart(3, '0')}.mp4`);
        await generateFixtureVideo(path, ffmpegPath, `0x${((index * 2654435761) >>> 0).toString(16).slice(0, 6).padStart(6, '0')}`, 1);
      }
      paths = await collectVideos(mediaRoot);
    }
    if (paths.length < requiredVideoCount) {
      console.log(JSON.stringify({ status: 'BLOCKED_BY_ENVIRONMENT', reason: `需要至少 ${requiredVideoCount} 个本地视频，当前只有 ${paths.length}`, mediaRoot }, null, 2));
      return;
    }
    paths = paths.slice(0, requiredVideoCount);

    const probeDurations: number[] = [];
    const probes: Array<{ path: string; durationMs: number; width: number; height: number }> = [];
    let start = performance.now();
    for (const path of paths) {
      const probeStart = performance.now();
      const probe = await probeMedia(path, ffprobePath);
      probeDurations.push(elapsed(probeStart));
      probes.push({ path, durationMs: Math.max(1, Math.round(probe.durationMs)), width: probe.width, height: probe.height });
    }
    const ffprobeMs = elapsed(start);

    const frameRoot = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'contentos-v3-frames-'));
    const frameDurations: number[] = [];
    try {
      for (const [index, probe] of probes.entries()) {
        const frameStart = performance.now();
        await generateRepresentativeFrames(probe.path, join(frameRoot, String(index)), probe.durationMs, ffmpegPath);
        frameDurations.push(elapsed(frameStart));
      }
    } finally { await rm(frameRoot, { recursive: true, force: true }); }

    const items: MaterialPoolItemV3[] = probes.map((probe, index) => ({ assetId: `benchmark-${index + 1}`, sourcePath: probe.path, fileName: probe.path.split(/[\\/]/u).at(-1) || `benchmark-${index + 1}.mp4`, durationMs: probe.durationMs, width: probe.width, height: probe.height, tags: [`benchmark-${index % 10}`], availability: 'VALID', aiStatus: 'NOT_REQUESTED' }));
    const indexer = new InMemoryMaterialSemanticIndex();
    start = performance.now();
    await indexer.build({ snapshotId: 'benchmark-snapshot', items });
    const indexBuildMs = elapsed(start);
    const queryLatencies: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const queryStart = performance.now();
      indexer.search({ snapshotId: 'benchmark-snapshot', queries: [`benchmark-${index % 10} 真实场景`], limit: 5 });
      queryLatencies.push(elapsed(queryStart));
    }

    const qwenStatus = process.env.QWEN_API_KEY && process.env.QWEN_BASE_URL ? 'configured_not_invoked' : 'not_configured';
    const result = {
      status: 'RECORDED',
      generatedFixtures: generated,
      mediaRoot,
      videoCount: paths.length,
      timingsMs: {
        materialScan: materialScanMs,
        ffprobeTotal: ffprobeMs,
        ffprobeAverage: percentile(probeDurations, 0.5),
        representativeFramesTotal: frameDurations.reduce((sum, value) => sum + value, 0),
        representativeFramesAverage: percentile(frameDurations, 0.5),
        aiAnalysisAverage: null,
        embeddingTotal: null,
        semanticIndexBuild: indexBuildMs,
        sentenceQueryP50: percentile(queryLatencies, 0.5),
        topKRetrievalP50: percentile(queryLatencies, 0.5),
        uiCandidateLoading: null,
      },
      qwen: { status: qwenStatus, note: '需在真实 Qwen 配置和 Gold Set 下单独记录 AI 延迟与效果；此脚本不在无授权时调用远端模型。' },
      aiRetrievalGoldSet: { status: 'BLOCKED_BY_DATA', reason: '仓库未提供人工标注 Gold Set 或真实 Qwen Profile，避免用合成标签冒充真实效果。' },
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (generatedRoot) await rm(generatedRoot, { recursive: true, force: true });
  }
}

await main();
