import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApprovalService } from '../../../packages/modules/approval/src/index.js';
import type { ProjectService } from '../../../packages/modules/project/src/index.js';
import type { VideoProjectReadService } from '../../../packages/modules/video/src/index.js';
import type { PublisherService } from '../../../packages/modules/publisher/src/index.js';
import type { DirectorV1Service } from '../../../packages/modules/director/src/index.js';

const approvalInput = z.object({
  targetType: z.enum(['SCRIPT', 'STORYBOARD', 'RENDER', 'PUBLISH']),
  targetId: z.string().trim().min(1),
  targetRevisionId: z.string().trim().min(1),
  status: z.literal('PENDING'),
  approver: z.string().trim().min(1),
  reason: z.string().trim().optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});
const approvalActionInput = z.object({ approver: z.string().trim().min(1), reason: z.string().trim().optional() });

export interface ApprovalRouteDependencies { projects: ProjectService; approvals: ApprovalService; video?: VideoProjectReadService; publisher?: PublisherService; director?: DirectorV1Service; }
function paramsOf(request: { params: unknown }): { projectId: string; targetType: string; targetId: string; targetRevisionId: string } { return request.params as { projectId: string; targetType: string; targetId: string; targetRevisionId: string }; }

export function registerApprovalRoutes(app: FastifyInstance, dependencies: ApprovalRouteDependencies): void {
  const { projects, approvals, publisher } = dependencies;
  const resolveTargetId = async (projectId: string, targetType: 'SCRIPT' | 'STORYBOARD' | 'RENDER' | 'PUBLISH', targetId: string, revisionId: string): Promise<string> => {
    if (dependencies.director && targetType === 'SCRIPT') return await dependencies.director.getScriptAggregateId(revisionId, projectId) || targetId;
    if (dependencies.director && targetType === 'STORYBOARD') return await dependencies.director.getStoryboardAggregateId(revisionId, projectId) || targetId;
    return targetId;
  };
  app.post('/api/v1/projects/:projectId/approvals', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = approvalInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid approval input', details: parsed.error.issues } });
    const { reason, evidence, ...base } = parsed.data;
    try {
      let targetId = base.targetId;
      if (dependencies.director && base.targetType === 'SCRIPT') targetId = await dependencies.director.getScriptAggregateId(base.targetRevisionId, projectId) || targetId;
      if (dependencies.director && base.targetType === 'STORYBOARD') targetId = await dependencies.director.getStoryboardAggregateId(base.targetRevisionId, projectId) || targetId;
      return reply.code(201).send(await approvals.create({ projectId, ...base, targetId, ...(reason ? { reason } : {}), ...(evidence ? { evidence } : {}) }));
    }
    catch (error) { return reply.code(422).send({ error: { code: 'APPROVAL_VALIDATION_ERROR', message: error instanceof Error ? error.message : 'Approval rejected', details: [] } }); }
  });

  app.get('/api/v1/projects/:projectId/approvals', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const all = await approvals.list(projectId);
    const current = new Map<string, typeof all[number]>();
    for (const decision of all) current.set(`${decision.targetType}:${decision.targetId}:${decision.targetRevisionId}`, decision);
    const items = await Promise.all([...current.values()].map(async (decision) => {
      let targetLabel = `${decision.targetType} ${decision.targetId}`;
      if (decision.targetType === 'PUBLISH' && publisher) {
        const aggregate = await publisher.getRequestAggregate(projectId, decision.targetId);
        if (aggregate) targetLabel = `发布 Revision ${aggregate.revision.id}`;
      }
      if (decision.targetType === 'RENDER') targetLabel = `成片 Render ${decision.targetId}`;
      return { ...decision, targetLabel };
    }));
    return { items };
  });

  app.get('/api/v1/projects/:projectId/approvals/:targetType/:targetId/:targetRevisionId/current', async (request, reply) => {
    const params = paramsOf(request);
    const targetType = z.enum(['SCRIPT', 'STORYBOARD', 'RENDER', 'PUBLISH']).safeParse(params.targetType);
    if (!targetType.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid approval target type', details: targetType.error.issues } });
    const current = await approvals.getCurrent(params.projectId, targetType.data, await resolveTargetId(params.projectId, targetType.data, params.targetId, params.targetRevisionId), params.targetRevisionId);
    if (!current) return reply.code(404).send({ error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval decision not found', details: [] } });
    return current;
  });

  app.post('/api/v1/projects/:projectId/approvals/:targetType/:targetId/:targetRevisionId/approve', async (request, reply) => {
    const params = paramsOf(request);
    const targetType = z.enum(['SCRIPT', 'STORYBOARD', 'RENDER', 'PUBLISH']).safeParse(params.targetType);
    const parsed = approvalActionInput.safeParse(request.body);
    if (!targetType.success || !parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid approval action', details: [...(targetType.success ? [] : targetType.error.issues), ...(parsed.success ? [] : parsed.error.issues)] } });
    try {
      const targetId = await resolveTargetId(params.projectId, targetType.data, params.targetId, params.targetRevisionId);
      const current = await approvals.getCurrent(params.projectId, targetType.data, targetId, params.targetRevisionId);
      if (!current) throw new Error('Approval decision not found');
      if (current.status !== 'PENDING') throw new Error(`Approval decision must be PENDING, got ${current.status}`);
      if (dependencies.director && targetType.data === 'SCRIPT') await dependencies.director.acceptScript(params.projectId, params.targetRevisionId);
      if (dependencies.director && targetType.data === 'STORYBOARD') await dependencies.director.approveStoryboard(params.projectId, params.targetRevisionId);
      // Advance Director first: if its transition fails, no APPROVED decision is persisted.
      return await approvals.approve(params.projectId, targetType.data, targetId, params.targetRevisionId, parsed.data.approver);
    }
    catch (error) { return reply.code(409).send({ error: { code: 'APPROVAL_TRANSITION_CONFLICT', message: error instanceof Error ? error.message : 'Approval transition conflict', details: [] } }); }
  });

  app.post('/api/v1/projects/:projectId/approvals/:targetType/:targetId/:targetRevisionId/reject', async (request, reply) => {
    const params = paramsOf(request);
    const targetType = z.enum(['SCRIPT', 'STORYBOARD', 'RENDER', 'PUBLISH']).safeParse(params.targetType);
    const parsed = approvalActionInput.safeParse(request.body);
    if (!targetType.success || !parsed.success || !parsed.data.reason) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'A rejection reason is required', details: [...(targetType.success ? [] : targetType.error.issues), ...(parsed.success ? [] : parsed.error.issues)] } });
    try { return await approvals.reject(params.projectId, targetType.data, await resolveTargetId(params.projectId, targetType.data, params.targetId, params.targetRevisionId), params.targetRevisionId, parsed.data.approver, parsed.data.reason); }
    catch (error) { return reply.code(409).send({ error: { code: 'APPROVAL_TRANSITION_CONFLICT', message: error instanceof Error ? error.message : 'Approval transition conflict', details: [] } }); }
  });
}
