import { JobRunner, type JobRecord, type JobService } from '../../../packages/modules/job/src/index.js';
import { BenchmarkService, BENCHMARK_ANALYZE, type BenchmarkAnalyzeJobPayload } from '../../../packages/modules/benchmark/src/index.js';
import { AIService } from '../../../packages/modules/ai/src/index.js';
import { validateBenchmarkAnalysisV1 } from '../../../packages/contracts/src/index.js';
import { randomUUID } from 'node:crypto';

export interface BenchmarkWorkerDependencies { jobs: JobService; benchmark: BenchmarkService; ai: AIService; }

function payloadOf(job: JobRecord): BenchmarkAnalyzeJobPayload {
  const payload = job.payload as Partial<BenchmarkAnalyzeJobPayload>;
  if (payload.schemaVersion !== 'BENCHMARK_ANALYZE_JOB_V1' || payload.projectId !== job.projectId || typeof payload.benchmarkContentId !== 'string') throw Object.assign(new Error('Invalid Benchmark Job payload'), { code: 'BENCHMARK_PAYLOAD_INVALID', retryable: false });
  return payload as BenchmarkAnalyzeJobPayload;
}

function analysisOutput(value: unknown): Omit<Parameters<BenchmarkService['recordAnalysis']>[0], 'id' | 'projectId' | 'benchmarkContentId' | 'aiRunId' | 'createdAt'> {
  if (!value || typeof value !== 'object') throw Object.assign(new Error('Benchmark analysis output must be an object'), { code: 'BENCHMARK_OUTPUT_INVALID', retryable: false });
  const candidate = value as Record<string, unknown>;
  const text = (key: string): string => { if (typeof candidate[key] !== 'string' || !String(candidate[key]).trim()) throw Object.assign(new Error(`Invalid Benchmark output field: ${key}`), { code: 'BENCHMARK_OUTPUT_INVALID', retryable: false }); return String(candidate[key]); };
  const list = (key: string): string[] => { if (!Array.isArray(candidate[key]) || candidate[key].length === 0 || candidate[key].some((item) => typeof item !== 'string' || !item.trim())) throw Object.assign(new Error(`Invalid Benchmark output field: ${key}`), { code: 'BENCHMARK_OUTPUT_INVALID', retryable: false }); return candidate[key] as string[]; };
  return { hook: text('hook'), openingStructure: text('openingStructure'), contentStructure: text('contentStructure'), informationDensity: text('informationDensity'), rhythm: text('rhythm'), emotionalChange: text('emotionalChange'), evidenceUsage: text('evidenceUsage'), storyOpinionStructure: text('storyOpinionStructure'), endingCta: text('endingCta'), titlePattern: text('titlePattern'), reusableStructure: text('reusableStructure'), successReasons: list('successReasons'), lessons: list('lessons'), doNotCopy: list('doNotCopy') };
}

export function createBenchmarkJobHandler(deps: BenchmarkWorkerDependencies): (job: JobRecord, attemptId: string, signal: AbortSignal) => Promise<unknown> {
  return async (job, attemptId, signal) => {
    if (job.type !== BENCHMARK_ANALYZE) throw Object.assign(new Error(`Unexpected Benchmark Job type: ${job.type}`), { code: 'BENCHMARK_JOB_TYPE_INVALID', retryable: false });
    const payload = payloadOf(job);
    const content = await deps.benchmark.getContent(payload.projectId, payload.benchmarkContentId);
    if (!content) throw Object.assign(new Error('Benchmark content not found for project'), { code: 'BENCHMARK_CONTENT_NOT_FOUND', retryable: false });
    signal.throwIfAborted();
    const result = await deps.ai.generateStructured({ projectId: payload.projectId, jobId: job.id, attemptId, correlationId: payload.correlationId, operation: 'BENCHMARK_ANALYZE', promptKey: 'benchmark.analysis.v1', variables: { platform: content.platform, title: content.title, copy: content.copy } }, (value) => analysisOutput(value));
    signal.throwIfAborted();
    const data = analysisOutput(result.output);
    const candidate = { schemaVersion: 'BENCHMARK_ANALYSIS_V1' as const, id: `validation-${randomUUID()}`, projectId: payload.projectId, benchmarkContentId: payload.benchmarkContentId, ...data, aiRunId: result.aiRunId, createdAt: new Date().toISOString() };
    validateBenchmarkAnalysisV1(candidate);
    const committed = await deps.jobs.succeedWithCurrentAttempt(job.id, attemptId, async (scope) => { const report = await deps.benchmark.recordAnalysis({ ...data, id: `benchmark-analysis-${randomUUID()}`, projectId: payload.projectId, benchmarkContentId: payload.benchmarkContentId, aiRunId: result.aiRunId, createdAt: new Date().toISOString() }, scope); return { analysisId: report.id, benchmarkContentId: report.benchmarkContentId, status: 'RECORDED' }; });
    return committed.executed ? committed.value : { status: 'STALE_ATTEMPT' };
  };
}
