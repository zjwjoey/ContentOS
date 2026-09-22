import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { PRODUCTION_RUN_STAGES, PRODUCTION_STEP_STATUSES, type ProductionRunStage, type ProductionStepStatus } from '../../../packages/contracts/src/index.js';
import type { ProductionRunService } from '../../../packages/modules/production-run/src/index.js';
import type { ProjectService } from '../../../packages/modules/project/src/index.js';
import type { ScriptEditingV3Service } from '../../../packages/modules/video/src/index.js';
import type { VideoService } from '../../../packages/modules/video/src/index.js';
import type { JobService } from '../../../packages/modules/job/src/index.js';
import type { ApprovalService } from '../../../packages/modules/approval/src/index.js';
import type { PublisherService } from '../../../packages/modules/publisher/src/index.js';
import type { DigitalHumanService } from '../../../packages/modules/digital-human/src/index.js';

const createInput = z.object({
  title: z.string().trim().min(1).max(200),
  digitalHumanMode: z.enum(['NONE', 'INTRO_ONLY', 'OUTRO_ONLY', 'FULL_TALKING_HEAD', 'CUSTOM']).optional(),
  approvalRequired: z.boolean().optional(), approvalBypassed: z.boolean().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
const stepInput = z.object({
  status: z.enum(PRODUCTION_STEP_STATUSES), inputRefs: z.record(z.string(), z.unknown()).optional(), outputRefs: z.record(z.string(), z.unknown()).optional(),
  errorCode: z.string().trim().max(200).nullable().optional(), errorMessage: z.string().trim().max(2000).nullable().optional(),
}).strict();
const stageInput = z.object({ stage: z.enum(PRODUCTION_RUN_STAGES) }).strict();

export function registerProductionRunRoutes(app: FastifyInstance, dependencies: { db: Pool; projects: ProjectService; productionRuns: ProductionRunService; editing?: ScriptEditingV3Service; jobs?: JobService; video?: VideoService; approvals?: ApprovalService; publisher?: PublisherService; digitalHuman?: DigitalHumanService }): void {
  const { db, projects, productionRuns, editing, jobs, video, approvals, publisher, digitalHuman } = dependencies;
  const projectExists = async (projectId: string, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    if (!(await projects.get(projectId))) { reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } }); return false; }
    return true;
  };
  const failure = (reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) => reply.code(409).send({ error: { code: error instanceof Error ? error.message.split(':')[0] : 'PRODUCTION_RUN_CONFLICT', message: error instanceof Error ? error.message : 'Production run conflict', details: [] } });

  app.get('/api/v1/projects/:projectId/production-runs', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await projectExists(projectId, reply))) return;
    return { items: await productionRuns.list(projectId) };
  });
  app.post('/api/v1/projects/:projectId/production-runs', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await projectExists(projectId, reply))) return;
    const parsed = createInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid production run input', details: parsed.error.issues } });
    try {
      // A production run is project-scoped. Material Pool and V3 Editing use the
      // same canonical workspace id, so make sure that workspace is linked to
      // this project before any downstream handoff creates a snapshot/session.
      await db.query("insert into video_workspaces (id,type,project_id) values ($1,'PROJECT',$2) on conflict (id) do update set type='PROJECT', project_id=excluded.project_id", [`workspace-project-${projectId}`, projectId]);
      return reply.code(201).send(await productionRuns.create({ projectId, title: parsed.data.title, ...(parsed.data.digitalHumanMode ? { digitalHumanMode: parsed.data.digitalHumanMode } : {}), ...(parsed.data.approvalRequired !== undefined ? { approvalRequired: parsed.data.approvalRequired } : {}), ...(parsed.data.approvalBypassed !== undefined ? { approvalBypassed: parsed.data.approvalBypassed } : {}), ...(parsed.data.idempotencyKey ? { idempotencyKey: parsed.data.idempotencyKey } : {}), ...(parsed.data.metadata ? { metadata: parsed.data.metadata } : {}) }));
    } catch (error) { return failure(reply, error); }
  });
  app.get('/api/v1/projects/:projectId/production-runs/:runId', async (request, reply) => {
    const params = request.params as { projectId: string; runId: string };
    if (!(await projectExists(params.projectId, reply))) return;
    const result = await productionRuns.get(params.projectId, params.runId);
    if (!result) return reply.code(404).send({ error: { code: 'PRODUCTION_RUN_NOT_FOUND', message: 'Production run not found', details: [] } });
    return result;
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/steps/:stage', async (request, reply) => {
    const params = request.params as { projectId: string; runId: string; stage: string };
    const stage = z.enum(PRODUCTION_RUN_STAGES).safeParse(params.stage);
    const parsed = stepInput.safeParse(request.body);
    if (!stage.success || !parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid production step input', details: [...(stage.success ? [] : stage.error.issues), ...(parsed.success ? [] : parsed.error.issues)] } });
    try { return await productionRuns.updateStep(params.projectId, params.runId, { stage: stage.data as ProductionRunStage, status: parsed.data.status as ProductionStepStatus, ...(parsed.data.inputRefs ? { inputRefs: parsed.data.inputRefs } : {}), ...(parsed.data.outputRefs ? { outputRefs: parsed.data.outputRefs } : {}), ...(parsed.data.errorCode !== undefined ? { errorCode: parsed.data.errorCode } : {}), ...(parsed.data.errorMessage !== undefined ? { errorMessage: parsed.data.errorMessage } : {}) }); } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/handoff/:stage', async (request, reply) => {
    const params = request.params as { projectId: string; runId: string; stage: string };
    const stage = z.enum(PRODUCTION_RUN_STAGES).safeParse(params.stage);
    const parsed = z.object({ outputRefs: z.record(z.string(), z.unknown()), status: z.enum(['SUCCEEDED', 'SKIPPED']).default('SUCCEEDED') }).strict().safeParse(request.body);
    if (!stage.success || !parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid production handoff', details: [...(stage.success ? [] : stage.error.issues), ...(parsed.success ? [] : parsed.error.issues)] } });
    try { return await productionRuns.handoff(params.projectId, params.runId, stage.data, parsed.data.outputRefs, parsed.data.status); } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/voice', async (request, reply) => {
    if (!digitalHuman) return reply.code(503).send({ error: { code: 'DIGITAL_HUMAN_SERVICE_UNAVAILABLE', message: 'Digital Human service is unavailable', details: [] } });
    const params = request.params as { projectId: string; runId: string }; const parsed = z.object({ voiceProfileId: z.string().trim().min(1), text: z.string().trim().min(1).max(100_000), provider: z.string().trim().min(1).optional() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid voice input', details: parsed.error.issues } });
    try { const result = await digitalHuman.createSpeechGeneration({ projectId: params.projectId, voiceProfileId: parsed.data.voiceProfileId, text: parsed.data.text, ...(parsed.data.provider ? { provider: parsed.data.provider } : {}), correlationId: `production-run:${params.runId}` }); const run = await productionRuns.updateStep(params.projectId, params.runId, { stage: 'VOICE', status: 'RUNNING', outputRefs: { speechGenerationId: result.generation.id, jobId: result.job.id } }); return reply.code(202).send({ generation: result.generation, job: result.job, run }); } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/digital-human', async (request, reply) => {
    if (!digitalHuman) return reply.code(503).send({ error: { code: 'DIGITAL_HUMAN_SERVICE_UNAVAILABLE', message: 'Digital Human service is unavailable', details: [] } });
    const params = request.params as { projectId: string; runId: string }; const parsed = z.object({ avatarProfileId: z.string().trim().min(1), avatarClipId: z.string().trim().min(1), speechAssetId: z.string().trim().min(1) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid digital human input', details: parsed.error.issues } });
    try { const result = await digitalHuman.createAvatarGeneration({ projectId: params.projectId, avatarProfileId: parsed.data.avatarProfileId, avatarClipId: parsed.data.avatarClipId, speechAssetId: parsed.data.speechAssetId, correlationId: `production-run:${params.runId}` }); const current = await productionRuns.get(params.projectId, params.runId); const speechGenerationId = typeof current?.trace.speechGenerationId === 'string' ? current.trace.speechGenerationId : undefined; const run = await productionRuns.updateStep(params.projectId, params.runId, { stage: 'DIGITAL_HUMAN', status: 'RUNNING', inputRefs: { ...(speechGenerationId ? { speechGenerationId } : {}), speechAssetId: parsed.data.speechAssetId }, outputRefs: { avatarGenerationId: result.generation.id, jobId: result.job.id } }); return reply.code(202).send({ generation: result.generation, job: result.job, run }); } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/editing-session', async (request, reply) => {
    if (!editing) return reply.code(503).send({ error: { code: 'SCRIPT_EDITING_UNAVAILABLE', message: 'Script editing service is unavailable', details: [] } });
    const params = request.params as { projectId: string; runId: string };
    const parsed = z.object({ scriptRevisionId: z.string().trim().min(1), materialPoolSnapshotId: z.string().trim().min(1), voicePath: z.string().trim().min(1).optional(), sentences: z.array(z.object({ text: z.string().trim().min(1), startMs: z.number().nonnegative().optional(), endMs: z.number().positive().optional(), durationMs: z.number().positive().optional() })).optional() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid editing handoff input', details: parsed.error.issues } });
    try {
      const script = (await db.query('select hook,body,cta,status from director_script_revisions where id=$1 and project_id=$2', [parsed.data.scriptRevisionId, params.projectId])).rows[0] as { hook?: string; body?: string; cta?: string | null; status?: string } | undefined;
      if (!script || script.status !== 'ACCEPTED') throw new Error('PRODUCTION_SCRIPT_REVISION_NOT_ACCEPTED');
      const workspaceId = `workspace-project-${params.projectId}`;
      const session = await editing.createSession({ workspaceId, snapshotId: parsed.data.materialPoolSnapshotId, script: [script.hook, script.body, script.cta].filter(Boolean).join('\n\n'), ...(parsed.data.voicePath ? { voicePath: parsed.data.voicePath } : {}), ...(parsed.data.sentences ? { sentences: parsed.data.sentences } : {}) });
      const updated = await productionRuns.updateStep(params.projectId, params.runId, { stage: 'EDITING', status: 'RUNNING', inputRefs: { scriptRevisionId: parsed.data.scriptRevisionId, materialPoolSnapshotId: parsed.data.materialPoolSnapshotId }, outputRefs: { editSessionId: session.id } });
      return reply.code(201).send({ session, run: updated });
    } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/editing-session/:sessionId/generate', async (request, reply) => {
    if (!editing) return reply.code(503).send({ error: { code: 'SCRIPT_EDITING_UNAVAILABLE', message: 'Script editing service is unavailable', details: [] } });
    const params = request.params as { projectId: string; runId: string; sessionId: string };
    try { const generated = await editing.generate(params.sessionId); const run = await productionRuns.handoff(params.projectId, params.runId, 'EDITING', { editSessionId: params.sessionId, manifestRevisionId: generated.manifestId }); return reply.code(201).send({ generated, run }); } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/preview', async (request, reply) => {
    if (!jobs) return reply.code(503).send({ error: { code: 'JOB_SERVICE_UNAVAILABLE', message: 'Job service is unavailable', details: [] } });
    const params = request.params as { projectId: string; runId: string }; const parsed = z.object({ mode: z.enum(['DRAFT', 'FAST']).default('DRAFT') }).strict().safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid preview input', details: parsed.error.issues } });
    try {
      const run = await productionRuns.get(params.projectId, params.runId); if (!run) throw new Error('PRODUCTION_RUN_NOT_FOUND');
      const editSessionId = typeof run.trace.editSessionId === 'string' ? run.trace.editSessionId : null; if (!editSessionId) throw new Error('PRODUCTION_EDIT_SESSION_REQUIRED');
      const session = (await db.query('select workspace_id,current_manifest_id,material_pool_snapshot_id from script_editing_v3_sessions where id=$1', [editSessionId])).rows[0] as { workspace_id?: string; current_manifest_id?: string; material_pool_snapshot_id?: string } | undefined;
      if (!session?.workspace_id || !session.current_manifest_id || !session.material_pool_snapshot_id) throw new Error('PRODUCTION_MANIFEST_NOT_READY');
      const job = await jobs.createIdempotent({ id: `job-production-preview-${params.runId}`, projectId: null, workspaceId: session.workspace_id, type: 'EDIT_V3_DRAFT_PREVIEW', payload: { schemaVersion: 'EDIT_V3_DRAFT_PREVIEW_V1', sessionId: editSessionId, manifestId: session.current_manifest_id, snapshotId: session.material_pool_snapshot_id, workspaceId: session.workspace_id, mode: parsed.data.mode }, idempotencyKey: `production-preview:${params.runId}:${session.current_manifest_id}:${parsed.data.mode}`, maxAttempts: 2 });
      const updated = await productionRuns.updateStep(params.projectId, params.runId, { stage: 'PREVIEW', status: 'RUNNING', inputRefs: { editSessionId, manifestId: session.current_manifest_id }, outputRefs: { jobId: job.id, manifestId: session.current_manifest_id } });
      return reply.code(202).send({ jobId: job.id, run: updated });
    } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/render', async (request, reply) => {
    if (!video) return reply.code(503).send({ error: { code: 'VIDEO_SERVICE_UNAVAILABLE', message: 'Video service is unavailable', details: [] } });
    const params = request.params as { projectId: string; runId: string };
    try {
      const run = await productionRuns.get(params.projectId, params.runId); if (!run) throw new Error('PRODUCTION_RUN_NOT_FOUND');
      if (run.approvalRequired && !run.approvalBypassed && run.steps.find((step) => step.stage === 'APPROVAL')?.status !== 'SUCCEEDED') throw new Error('PRODUCTION_APPROVAL_REQUIRED');
      const manifestId = typeof run.trace.manifestRevisionId === 'string' ? run.trace.manifestRevisionId : null; if (!manifestId) throw new Error('PRODUCTION_APPROVED_MANIFEST_REQUIRED');
      const row = (await db.query('select project_id,workspace_id from edit_manifests where id=$1', [manifestId])).rows[0] as { project_id?: string | null; workspace_id?: string } | undefined; if (!row) throw new Error('PRODUCTION_MANIFEST_NOT_FOUND');
      const job = row.workspace_id ? await video.createManifestRenderJobForWorkspace(String(row.workspace_id), manifestId, `production-run:${params.runId}`) : await video.createManifestRenderJob(params.projectId, manifestId);
      const updated = await productionRuns.updateStep(params.projectId, params.runId, { stage: 'RENDER', status: 'RUNNING', inputRefs: { manifestRevisionId: manifestId }, outputRefs: { jobId: job.id, manifestId } });
      return reply.code(202).send({ jobId: job.id, run: updated });
    } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/request-approval', async (request, reply) => {
    if (!approvals) return reply.code(503).send({ error: { code: 'APPROVAL_SERVICE_UNAVAILABLE', message: 'Approval service is unavailable', details: [] } });
    const params = request.params as { projectId: string; runId: string }; const parsed = z.object({ approver: z.string().trim().min(1).default('operator'), reason: z.string().trim().max(500).optional() }).strict().safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid approval request', details: parsed.error.issues } });
    try {
      const run = await productionRuns.get(params.projectId, params.runId); if (!run) throw new Error('PRODUCTION_RUN_NOT_FOUND');
      const manifestId = typeof run.trace.manifestRevisionId === 'string' ? run.trace.manifestRevisionId : null; if (!manifestId) throw new Error('PRODUCTION_PREVIEW_MANIFEST_REQUIRED');
      const approval = await approvals.create({ projectId: params.projectId, targetType: 'RENDER', targetId: manifestId, targetRevisionId: manifestId, status: 'PENDING', approver: parsed.data.approver, ...(parsed.data.reason ? { reason: parsed.data.reason } : {}), evidence: { productionRunId: params.runId } });
      const updated = await productionRuns.updateStep(params.projectId, params.runId, { stage: 'APPROVAL', status: 'WAITING_USER', inputRefs: { manifestRevisionId: manifestId }, outputRefs: { approvalId: approval.id } });
      return reply.code(201).send({ approval, run: updated });
    } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/approve', async (request, reply) => {
    if (!approvals) return reply.code(503).send({ error: { code: 'APPROVAL_SERVICE_UNAVAILABLE', message: 'Approval service is unavailable', details: [] } });
    const params = request.params as { projectId: string; runId: string }; const parsed = z.object({ approver: z.string().trim().min(1).default('operator') }).strict().safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid approval action', details: parsed.error.issues } });
     try { const run = await productionRuns.get(params.projectId, params.runId); if (!run) throw new Error('PRODUCTION_RUN_NOT_FOUND'); const manifestId = typeof run.trace.manifestRevisionId === 'string' ? run.trace.manifestRevisionId : null; const approvalId = typeof run.trace.approvalId === 'string' ? run.trace.approvalId : null; if (!manifestId || !approvalId) throw new Error('PRODUCTION_APPROVAL_REQUIRED'); const approved = await approvals.approve(params.projectId, 'RENDER', manifestId, manifestId, parsed.data.approver); return await productionRuns.handoff(params.projectId, params.runId, 'APPROVAL', { approvalId: approved.id, manifestRevisionId: manifestId }); } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/request-changes', async (request, reply) => {
    if (!approvals) return reply.code(503).send({ error: { code: 'APPROVAL_SERVICE_UNAVAILABLE', message: 'Approval service is unavailable', details: [] } });
    const params = request.params as { projectId: string; runId: string }; const parsed = z.object({ approver: z.string().trim().min(1).default('operator'), reason: z.string().trim().min(1).max(1000) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'A change reason is required', details: parsed.error.issues } });
    try { const run = await productionRuns.get(params.projectId, params.runId); if (!run) throw new Error('PRODUCTION_RUN_NOT_FOUND'); const manifestId = typeof run.trace.manifestRevisionId === 'string' ? run.trace.manifestRevisionId : null; if (!manifestId) throw new Error('PRODUCTION_APPROVAL_REQUIRED'); await approvals.reject(params.projectId, 'RENDER', manifestId, manifestId, parsed.data.approver, parsed.data.reason); return await productionRuns.resetForChanges(params.projectId, params.runId); } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/publisher-request', async (request, reply) => {
    if (!publisher) return reply.code(503).send({ error: { code: 'PUBLISHER_SERVICE_UNAVAILABLE', message: 'Publisher service is unavailable', details: [] } });
    const params = request.params as { projectId: string; runId: string }; const parsed = z.object({ accountId: z.string().trim().min(1), title: z.string().trim().min(1).max(200), description: z.string().trim().max(5000).default(''), hashtags: z.array(z.string().trim().min(1)).max(30).default([]) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid publisher request', details: parsed.error.issues } });
    try {
      const run = await productionRuns.get(params.projectId, params.runId); if (!run) throw new Error('PRODUCTION_RUN_NOT_FOUND'); const renderAssetId = typeof run.trace.renderAssetId === 'string' ? run.trace.renderAssetId : null; if (!renderAssetId) throw new Error('PRODUCTION_RENDER_ASSET_REQUIRED'); const asset = (await db.query("select id,checksum from assets where id=$1 and project_id=$2 and lifecycle='READY'", [renderAssetId, params.projectId])).rows[0] as { id: string; checksum: string } | undefined; if (!asset) throw new Error('PRODUCTION_RENDER_ASSET_NOT_READY');
      const requestAggregate = await publisher.createRequest({ projectId: params.projectId, accountId: parsed.data.accountId, idempotencyKey: `production-publish:${params.runId}:${parsed.data.accountId}:${renderAssetId}`, correlationId: `production-run:${params.runId}`, revision: { assetId: asset.id, assetChecksum: asset.checksum, title: parsed.data.title, description: parsed.data.description, hashtags: parsed.data.hashtags, desiredPublishAt: null, createdBy: 'production-run' } });
      const updated = await productionRuns.updateStep(params.projectId, params.runId, { stage: 'PUBLISH', status: 'WAITING_USER', inputRefs: { renderAssetId }, outputRefs: { publishRequestId: requestAggregate.request.id } });
      return reply.code(201).send({ request: requestAggregate, run: updated });
    } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/publish', async (request, reply) => {
    if (!publisher || !jobs || !approvals) return reply.code(503).send({ error: { code: 'PUBLISHER_SERVICE_UNAVAILABLE', message: 'Publisher service is unavailable', details: [] } });
    const params = request.params as { projectId: string; runId: string };
    try {
      const run = await productionRuns.get(params.projectId, params.runId); if (!run) throw new Error('PRODUCTION_RUN_NOT_FOUND');
      const publishStep = run.steps.find((step) => step.stage === 'PUBLISH');
      if (publishStep?.status === 'SUCCEEDED') return { jobId: typeof run.trace.publishJobId === 'string' ? run.trace.publishJobId : null, run };
      const requestId = typeof run.trace.publishRequestId === 'string' ? run.trace.publishRequestId : null; if (!requestId) throw new Error('PRODUCTION_PUBLISH_REQUEST_REQUIRED');
      const aggregate = await publisher.getRequestAggregate(params.projectId, requestId); if (!aggregate) throw new Error('PRODUCTION_PUBLISH_REQUEST_NOT_FOUND');
      const approval = await approvals.getCurrent(params.projectId, 'PUBLISH', requestId, aggregate.revision.id); if (!approval || approval.status !== 'APPROVED') throw new Error('PRODUCTION_PUBLISH_APPROVAL_REQUIRED');
      const jobId = `job-publish-${requestId}-${aggregate.revision.revision}`;
      const payload = await publisher.buildPublishJobPayload(params.projectId, requestId, jobId, null);
      const job = await jobs.createIdempotent({ id: jobId, type: 'PUBLISH', projectId: params.projectId, payload, idempotencyKey: `publisher:publish:${requestId}:${aggregate.revision.id}`, maxAttempts: 3, ...(aggregate.request.desiredPublishAt ? { scheduledAt: aggregate.request.desiredPublishAt } : {}) });
      if (!['QUEUED', 'SCHEDULED'].includes(aggregate.request.status)) await publisher.transitionRequest(requestId, aggregate.request.desiredPublishAt && new Date(aggregate.request.desiredPublishAt).getTime() > Date.now() ? 'SCHEDULED' : 'QUEUED');
      const updated = await productionRuns.updateStep(params.projectId, params.runId, { stage: 'PUBLISH', status: 'RUNNING', inputRefs: { publishRequestId: requestId }, outputRefs: { publishRequestId: requestId, publishJobId: job.id } });
      return reply.code(202).send({ jobId: job.id, run: updated });
    } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/review', async (request, reply) => {
    const params = request.params as { projectId: string; runId: string }; const parsed = z.object({ reviewId: z.string().trim().min(1).optional(), externalPostId: z.string().trim().min(1).optional() }).strict().refine((value) => Boolean(value.reviewId || value.externalPostId), { message: 'reviewId or externalPostId is required' }).safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid review handoff', details: parsed.error.issues } });
    try { const refs = { ...(parsed.data.reviewId ? { reviewId: parsed.data.reviewId } : {}), ...(parsed.data.externalPostId ? { externalPostId: parsed.data.externalPostId } : {}) }; return await productionRuns.handoff(params.projectId, params.runId, 'REVIEW', refs); } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/retry', async (request, reply) => {
    const params = request.params as { projectId: string; runId: string }; const parsed = stageInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid retry input', details: parsed.error.issues } });
    try { return await productionRuns.retry(params.projectId, params.runId, parsed.data.stage); } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/cancel', async (request, reply) => {
    const params = request.params as { projectId: string; runId: string };
    try { return await productionRuns.cancel(params.projectId, params.runId); } catch (error) { return failure(reply, error); }
  });
  app.post('/api/v1/projects/:projectId/production-runs/:runId/reconcile', async (request, reply) => {
    const params = request.params as { projectId: string; runId: string };
    try { return await productionRuns.reconcile(params.projectId, params.runId); } catch (error) { return failure(reply, error); }
  });
}
