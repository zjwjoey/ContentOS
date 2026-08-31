import { JobRunner, type JobRecord, type JobService } from '../../../packages/modules/job/src/index.js';
import { AIService } from '../../../packages/modules/ai/src/ai-service.js';
import { DirectorV1Service } from '../../../packages/modules/director/src/director-v1-service.js';
import { DIRECTOR_GENERATE_SCRIPT, DIRECTOR_GENERATE_STORYBOARD, type DirectorJobPayload, type DirectorJobType } from '../../../packages/modules/director/src/director-job-service.js';
import type { ModelProfile } from '../../../packages/contracts/src/index.js';

export interface DirectorWorkerDependencies { jobs: JobService; director: DirectorV1Service; ai: AIService; modelProfile: ModelProfile; }
export interface DirectorWorkerInvocation { jobId: string; }

function payloadOf(job: JobRecord): DirectorJobPayload {
  const payload = job.payload as Partial<DirectorJobPayload>;
  if (payload.schemaVersion !== 'DIRECTOR_JOB_PAYLOAD_V1' || typeof payload.projectId !== 'string' || typeof payload.correlationId !== 'string') throw new Error('Invalid Director Job payload');
  return payload as DirectorJobPayload;
}

function scriptOutput(value: unknown): { origin: 'AI'; title: string; titleCandidates: string[]; coverText: string; topicKeywords: string[]; hook: string; body: string; cta?: string; createdBy: string } {
  const output = value as Record<string, unknown>; const required = (key: string): string => { if (typeof output[key] !== 'string' || !String(output[key]).trim()) throw new Error(`Invalid Script output field: ${key}`); return String(output[key]); }; const list = (key: string): string[] => { if (!Array.isArray(output[key]) || output[key].length === 0 || output[key].some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`Invalid Script output field: ${key}`); return output[key] as string[]; };
  const cta = output.cta === undefined ? undefined : required('cta'); return { origin: 'AI', title: required('title'), titleCandidates: list('titleCandidates'), coverText: required('coverText'), topicKeywords: list('topicKeywords'), hook: required('hook'), body: required('body'), ...(cta === undefined ? {} : { cta }), createdBy: 'director-worker' };
}

function storyboardOutput(value: unknown): { origin: 'AI'; scriptRevisionId: string; scenes: Array<{ sceneIndex: number; voiceoverText: string; durationHintSeconds: number; visualInstruction: string; assetKeywords: string[] }>; createdBy: string } {
  const output = value as Record<string, unknown>; if (!Array.isArray(output.scenes) || output.scenes.length === 0) throw new Error('Invalid Storyboard output field: scenes'); return { origin: 'AI', scriptRevisionId: '', scenes: output.scenes as Array<{ sceneIndex: number; voiceoverText: string; durationHintSeconds: number; visualInstruction: string; assetKeywords: string[] }>, createdBy: 'director-worker' };
}

async function process(job: JobRecord, attemptId: string, type: DirectorJobType, deps: DirectorWorkerDependencies): Promise<unknown> {
  if (job.type !== type) throw new Error(`Unexpected Director Job type: ${job.type}`);
  const payload = payloadOf(job); if (payload.projectId !== job.projectId) throw new Error('Director Job project mismatch');
  const brief = await deps.director.getBrief('briefId' in payload ? payload.briefId : (await deps.director.getCurrentPair(payload.projectId)).brief?.id ?? '', payload.projectId); if (!brief) throw new Error('Director Job Brief not found');
  if (type === DIRECTOR_GENERATE_SCRIPT) {
    if (!('scriptAggregateId' in payload)) throw new Error('Script Job requires scriptAggregateId');
    const result = await deps.ai.generateStructured({ projectId: payload.projectId, jobId: job.id, attemptId, correlationId: payload.correlationId, operation: DIRECTOR_GENERATE_SCRIPT, promptKey: 'director.script.v2', variables: { brief: JSON.stringify(brief) } }, scriptOutput);
    const revision = await deps.director.createScriptRevision(payload.projectId, payload.scriptAggregateId, { ...scriptOutput(result.output), aiRunId: result.aiRunId, promptVersionId: result.promptVersionId, sourceJobId: job.id }); return { scriptRevisionId: revision.id, aiRunId: result.aiRunId };
  }
  if (!('scriptRevisionId' in payload)) throw new Error('Storyboard Job requires scriptRevisionId');
  const script = await deps.director.getScriptRevision(payload.scriptRevisionId, payload.projectId); if (!script) throw new Error('Storyboard source Script not found for project');
  const result = await deps.ai.generateStructured({ projectId: payload.projectId, jobId: job.id, attemptId, correlationId: payload.correlationId, operation: DIRECTOR_GENERATE_STORYBOARD, promptKey: 'director.storyboard.v2', variables: { brief: JSON.stringify(brief), script: JSON.stringify(script) } }, storyboardOutput);
  const parsed = storyboardOutput(result.output); const revision = await deps.director.createStoryboardRevision(payload.projectId, payload.storyboardAggregateId, { ...parsed, scriptRevisionId: payload.scriptRevisionId, aiRunId: result.aiRunId, promptVersionId: result.promptVersionId, sourceJobId: job.id }); return { storyboardRevisionId: revision.id, aiRunId: result.aiRunId };
}

export function createDirectorJobHandler(type: DirectorJobType, deps: DirectorWorkerDependencies): (invocation: unknown) => Promise<unknown> {
  return async (invocation: unknown) => {
    const jobId = (invocation as DirectorWorkerInvocation | undefined)?.jobId; if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Director worker invocation requires jobId');
    return new JobRunner(deps.jobs, 'director-worker').run(jobId, (job, attemptId) => process(job, attemptId, type, deps));
  };
}
