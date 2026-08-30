import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApprovalService } from '../../../packages/modules/approval/src/index.js';
import type { ProjectService } from '../../../packages/modules/project/src/index.js';
import type { VideoProjectReadService } from '../../../packages/modules/video/src/index.js';
import type { PublisherService } from '../../../packages/modules/publisher/src/index.js';

const approvalInput = z
  .object({
    targetType: z.enum(['RENDER', 'PUBLISH']),
    targetId: z.string().trim().min(1),
    targetRevisionId: z.string().trim().min(1),
    status: z.literal('PENDING').optional(),
    approver: z.string().trim().min(1),
    reason: z.string().trim().optional(),
    evidence: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const approvalActionInput = z.object({ approver: z.string().trim().min(1), reason: z.string().trim().optional() });

export interface ApprovalRouteDependencies {
  projects: ProjectService;
  approvals: ApprovalService;
  video?: VideoProjectReadService;
  publisher?: PublisherService;
}
function paramsOf(request: { params: unknown }): { projectId: string; targetType: string; targetId: string; targetRevisionId: string } {
  return request.params as { projectId: string; targetType: string; targetId: string; targetRevisionId: string };
}

export function registerApprovalRoutes(app: FastifyInstance, dependencies: ApprovalRouteDependencies): void {
  const { projects, approvals, publisher, video } = dependencies;
  app.post('/api/v1/projects/:projectId/approvals', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const parsed = approvalInput.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid approval input', details: parsed.error.issues } });
    const { reason, evidence, status: _status, ...base } = parsed.data;
    try {
      if (parsed.data.targetType === 'RENDER') {
        const currentRender = video ? await video.getCurrentRender(projectId) : null;
        if (!currentRender || currentRender.renderId !== parsed.data.targetId || currentRender.outputAssetId !== parsed.data.targetRevisionId)
          return reply
            .code(422)
            .send({ error: { code: 'APPROVAL_RENDER_TARGET_INVALID', message: 'Render Approval target must match the current project output', details: [] } });
      } else {
        const aggregate = publisher ? await publisher.getRequestAggregate(projectId, parsed.data.targetId) : null;
        if (!aggregate || aggregate.revision.id !== parsed.data.targetRevisionId)
          return reply.code(422).send({
            error: { code: 'APPROVAL_PUBLISH_TARGET_INVALID', message: 'Publish Approval target must match the current Publisher revision', details: [] },
          });
      }
      return reply
        .code(201)
        .send(await approvals.create({ projectId, ...base, status: 'PENDING', ...(reason ? { reason } : {}), ...(evidence ? { evidence } : {}) }));
    } catch (error) {
      return reply
        .code(422)
        .send({ error: { code: 'APPROVAL_VALIDATION_ERROR', message: error instanceof Error ? error.message : 'Approval rejected', details: [] } });
    }
  });

  app.get('/api/v1/projects/:projectId/approvals', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!(await projects.get(projectId))) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    const all = await approvals.list(projectId);
    const current = new Map<string, (typeof all)[number]>();
    for (const decision of all) current.set(`${decision.targetType}:${decision.targetId}:${decision.targetRevisionId}`, decision);
    const items = await Promise.all(
      [...current.values()].map(async (decision) => {
        let targetLabel = `${decision.targetType} ${decision.targetId}`;
        if (decision.targetType === 'PUBLISH' && publisher) {
          const aggregate = await publisher.getRequestAggregate(projectId, decision.targetId);
          if (aggregate) targetLabel = `发布 Revision ${aggregate.revision.id}`;
        }
        if (decision.targetType === 'RENDER') targetLabel = `成片 Render ${decision.targetId}`;
        return { ...decision, targetLabel };
      }),
    );
    return { items };
  });

  app.get('/api/v1/projects/:projectId/approvals/:targetType/:targetId/:targetRevisionId/current', async (request, reply) => {
    const params = paramsOf(request);
    const targetType = z.enum(['RENDER', 'PUBLISH']).safeParse(params.targetType);
    if (!targetType.success)
      return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid approval target type', details: targetType.error.issues } });
    const current = await approvals.getCurrent(params.projectId, targetType.data, params.targetId, params.targetRevisionId);
    if (!current) return reply.code(404).send({ error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval decision not found', details: [] } });
    return current;
  });

  app.post('/api/v1/projects/:projectId/approvals/:targetType/:targetId/:targetRevisionId/approve', async (request, reply) => {
    const params = paramsOf(request);
    const targetType = z.enum(['RENDER', 'PUBLISH']).safeParse(params.targetType);
    const parsed = approvalActionInput.safeParse(request.body);
    if (!targetType.success || !parsed.success)
      return reply.code(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid approval action',
          details: [...(targetType.success ? [] : targetType.error.issues), ...(parsed.success ? [] : parsed.error.issues)],
        },
      });
    try {
      return await approvals.approve(params.projectId, targetType.data, params.targetId, params.targetRevisionId, parsed.data.approver);
    } catch (error) {
      return reply.code(409).send({
        error: { code: 'APPROVAL_TRANSITION_CONFLICT', message: error instanceof Error ? error.message : 'Approval transition conflict', details: [] },
      });
    }
  });

  app.post('/api/v1/projects/:projectId/approvals/:targetType/:targetId/:targetRevisionId/reject', async (request, reply) => {
    const params = paramsOf(request);
    const targetType = z.enum(['RENDER', 'PUBLISH']).safeParse(params.targetType);
    const parsed = approvalActionInput.safeParse(request.body);
    if (!targetType.success || !parsed.success || !parsed.data.reason)
      return reply.code(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'A rejection reason is required',
          details: [...(targetType.success ? [] : targetType.error.issues), ...(parsed.success ? [] : parsed.error.issues)],
        },
      });
    try {
      return await approvals.reject(params.projectId, targetType.data, params.targetId, params.targetRevisionId, parsed.data.approver, parsed.data.reason);
    } catch (error) {
      return reply.code(409).send({
        error: { code: 'APPROVAL_TRANSITION_CONFLICT', message: error instanceof Error ? error.message : 'Approval transition conflict', details: [] },
      });
    }
  });
}
