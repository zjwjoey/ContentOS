import { randomUUID } from 'node:crypto';
import type { JobRecord, JobService } from '../../job/src/index.js';
export const BENCHMARK_ANALYZE = 'BENCHMARK_ANALYZE';
export interface BenchmarkAnalyzeJobPayload { schemaVersion: 'BENCHMARK_ANALYZE_JOB_V1'; projectId: string; benchmarkContentId: string; correlationId: string; idempotencyKey: string; }
export class BenchmarkJobService {
  constructor(private readonly jobs: JobService) {}
  async createAnalysisJob(input: Omit<BenchmarkAnalyzeJobPayload, 'schemaVersion'>): Promise<JobRecord> {
    const payload: BenchmarkAnalyzeJobPayload = { schemaVersion: 'BENCHMARK_ANALYZE_JOB_V1', ...input };
    const existing = await this.jobs.getByIdempotencyKey(input.idempotencyKey);
    if (existing) { if (existing.type !== BENCHMARK_ANALYZE || JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw new Error('Idempotency key conflict: input does not match existing Benchmark Job'); return existing; }
    return this.jobs.createIdempotent({ id: `benchmark-job-${randomUUID()}`, type: BENCHMARK_ANALYZE, projectId: input.projectId, payload, idempotencyKey: input.idempotencyKey, maxAttempts: 3 });
  }
}
