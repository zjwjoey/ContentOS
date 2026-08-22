import { randomUUID } from 'node:crypto';
import type { JobRecord, JobService } from '../../job/src/index.js';

export const DIRECTOR_GENERATE_SCRIPT = 'DIRECTOR_GENERATE_SCRIPT' as const;
export const DIRECTOR_GENERATE_STORYBOARD = 'DIRECTOR_GENERATE_STORYBOARD' as const;
export type DirectorJobType = typeof DIRECTOR_GENERATE_SCRIPT | typeof DIRECTOR_GENERATE_STORYBOARD;

export interface DirectorScriptJobPayload { schemaVersion: 'DIRECTOR_JOB_PAYLOAD_V1'; projectId: string; briefId: string; scriptAggregateId: string; modelProfileId: string; correlationId: string; }
export interface DirectorStoryboardJobPayload { schemaVersion: 'DIRECTOR_JOB_PAYLOAD_V1'; projectId: string; scriptRevisionId: string; storyboardAggregateId: string; modelProfileId: string; correlationId: string; }
export type DirectorJobPayload = DirectorScriptJobPayload | DirectorStoryboardJobPayload;

export interface CreateScriptGenerationInput { projectId: string; briefId: string; scriptAggregateId: string; modelProfileId?: string; correlationId: string; }
export interface CreateStoryboardGenerationInput { projectId: string; scriptRevisionId: string; storyboardAggregateId: string; modelProfileId?: string; correlationId: string; }

export class DirectorJobService {
  constructor(private readonly jobs: JobService) {}

  async createScriptGeneration(input: CreateScriptGenerationInput): Promise<JobRecord> {
    const payload: DirectorScriptJobPayload = { schemaVersion: 'DIRECTOR_JOB_PAYLOAD_V1', projectId: input.projectId, briefId: input.briefId, scriptAggregateId: input.scriptAggregateId, modelProfileId: input.modelProfileId ?? 'default', correlationId: input.correlationId };
    return this.create(DIRECTOR_GENERATE_SCRIPT, input.projectId, payload, `${DIRECTOR_GENERATE_SCRIPT}:${input.projectId}:${input.briefId}:${input.scriptAggregateId}`);
  }

  async createStoryboardGeneration(input: CreateStoryboardGenerationInput): Promise<JobRecord> {
    const payload: DirectorStoryboardJobPayload = { schemaVersion: 'DIRECTOR_JOB_PAYLOAD_V1', projectId: input.projectId, scriptRevisionId: input.scriptRevisionId, storyboardAggregateId: input.storyboardAggregateId, modelProfileId: input.modelProfileId ?? 'default', correlationId: input.correlationId };
    return this.create(DIRECTOR_GENERATE_STORYBOARD, input.projectId, payload, `${DIRECTOR_GENERATE_STORYBOARD}:${input.projectId}:${input.scriptRevisionId}:${input.storyboardAggregateId}`);
  }

  private async create(type: DirectorJobType, projectId: string, payload: DirectorJobPayload, idempotencyKey: string): Promise<JobRecord> {
    const existing = await this.jobs.getByIdempotencyKey(idempotencyKey); if (existing) return existing;
    try { return await this.jobs.create({ id: `job-${randomUUID()}`, type, projectId, payload, idempotencyKey, maxAttempts: 3 }); }
    catch (error) { const duplicate = await this.jobs.getByIdempotencyKey(idempotencyKey); if (duplicate) return duplicate; throw error; }
  }
}
