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
function stats(values: number[]): { p50: number; p95: number; max: number } { return { p50: percentile(values, 0.5) || 0, p95: percentile(values, 0.95) || 0, max: Math.max(...values, 0) }; }
function measure(operation: () => void, repetitions = 20): { p50: number; p95: number; max: number } { const values: number[] = []; for (let index = 0; index < repetitions; index += 1) { const start = performance.now(); operation(); values.push(elapsed(start)); } return stats(values); }

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

    const scaleBenchmarks = [] as Array<{ datasetSize: number; snapshotCreation: { p50: number; p95: number; max: number }; assetLibraryQuery: { p50: number; p95: number; max: number }; candidateSearch: { p50: number; p95: number; max: number }; manualFilter: { p50: number; p95: number; max: number }; goldFilter: { p50: number; p95: number; max: number }; usageRanking: { p50: number; p95: number; max: number }; shotSegmentRetrieval: { p50: number; p95: number; max: number }; workbenchInitialLoad: { p50: number; p95: number; max: number }; nPlusOneQueries: number }>;
    for (const datasetSize of [100, 500, 1000]) {
      const scaledItems: MaterialPoolItemV3[] = Array.from({ length: datasetSize }, (_, index) => ({ ...items[index % items.length]!, assetId: `benchmark-${datasetSize}-${index + 1}` }));
      const scaled = new InMemoryMaterialSemanticIndex();
      const buildStart = performance.now();
      await scaled.build({ snapshotId: `benchmark-${datasetSize}`, items: scaledItems });
      const snapshotCreation = stats([elapsed(buildStart)]);
      const libraryRows = scaledItems.map((item, index) => ({ ...item, gold: index % 7 === 0, usageCount: index % 11, recentUseCount: index % 5, shots: Array.from({ length: 3 }, (_, shotIndex) => ({ sourceInMs: shotIndex * 1_000, sourceOutMs: (shotIndex + 1) * 1_000 })) }));
      const assetLibraryQuery = measure(() => libraryRows.filter((item) => item.fileName.includes('benchmark')).slice(0, 50));
      const candidateSearch = measure(() => scaled.search({ snapshotId: `benchmark-${datasetSize}`, queries: ['benchmark-7 真实场景'], limit: 20 }));
      const manualFilter = measure(() => libraryRows.filter((item) => item.tags.includes('benchmark-7')).slice(0, 50));
      const goldFilter = measure(() => libraryRows.filter((item) => item.gold).slice(0, 50));
      const usageRanking = measure(() => [...libraryRows].sort((left, right) => right.usageCount - left.usageCount || right.recentUseCount - left.recentUseCount).slice(0, 50));
      const shotSegmentRetrieval = measure(() => libraryRows.flatMap((item) => item.shots).slice(0, 50));
      const workbenchInitialLoad = measure(() => libraryRows.slice(0, 50).map((item) => ({ assetId: item.assetId, fileName: item.fileName, durationMs: item.durationMs, tags: item.tags })));
      scaleBenchmarks.push({ datasetSize, snapshotCreation, assetLibraryQuery, candidateSearch, manualFilter, goldFilter, usageRanking, shotSegmentRetrieval, workbenchInitialLoad, nPlusOneQueries: 1 });
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
      benchmarkScope: 'local_in_memory_operator_workload',
      benchmarkNote: '100/500/1000 的 Asset Library、Candidate、Filter、Gold、Usage、Shots、Workbench 指标在同一批确定性内存数据上测量；实际数据库延迟需在目标部署数据库上另行记录。每页固定 50 条，批量读取假设为 1 次查询，不构造 N+1。',
      scaleBenchmarks,
      aiRetrievalGoldSet: { status: 'BLOCKED_BY_DATA', reason: '仓库未提供人工标注 Gold Set 或真实 Qwen Profile，避免用合成标签冒充真实效果。' },
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (generatedRoot) await rm(generatedRoot, { recursive: true, force: true });
  }
}

await main();
