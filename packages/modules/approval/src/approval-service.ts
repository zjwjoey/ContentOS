import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { validateApprovalDecision, type ApprovalDecisionV0, type ApprovalStatus, type ApprovalTargetType } from '../../../contracts/src/index.js';
import { ProjectService } from '../../project/src/index.js';

export interface ApprovalRecord {
  id: string;
  projectId: string;
  targetType: ApprovalTargetType;
  targetId: string;
  targetRevisionId: string;
  revision: number;
  status: ApprovalStatus;
  approver: string;
  reason?: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export type ApprovalCreateInput = {
  projectId: string;
  targetType: ApprovalTargetType;
  targetId: string;
  targetRevisionId: string;
  status: ApprovalStatus;
  approver: string;
  reason?: string;
  evidence?: Record<string, unknown>;
  schemaVersion?: 'APPROVAL_V0';
};

function mapApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id), projectId: String(row.project_id), targetType: String(row.target_type) as ApprovalTargetType,
    targetId: String(row.target_id), targetRevisionId: String(row.target_revision_id), revision: Number(row.revision),
    status: String(row.status) as ApprovalStatus, approver: String(row.approver), ...(row.reason ? { reason: String(row.reason) } : {}),
    evidence: row.evidence && typeof row.evidence === 'object' ? row.evidence as Record<string, unknown> : {}, createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export class ApprovalService {
  constructor(private readonly db: Pool, private readonly projects = new ProjectService(db)) {}

  private async assertProject(projectId: string): Promise<void> { if (!(await this.projects.get(projectId))) throw new Error(`Project ${projectId} not found`); }

  async create(input: ApprovalCreateInput): Promise<ApprovalRecord> {
    if (input.status !== 'PENDING') throw new Error(`Approval decision must start as PENDING, got ${input.status}`);
    return this.insert(input);
  }

  private async insert(input: ApprovalCreateInput): Promise<ApprovalRecord> {
    const decision: ApprovalDecisionV0 = { schemaVersion: input.schemaVersion || 'APPROVAL_V0', projectId: input.projectId, targetType: input.targetType, targetId: input.targetId, targetRevisionId: input.targetRevisionId, status: input.status, approver: input.approver, ...(input.reason !== undefined ? { reason: input.reason } : {}), ...(input.evidence !== undefined ? { evidence: input.evidence } : {}) };
    validateApprovalDecision(decision);
    await this.assertProject(decision.projectId);
    const next = await this.db.query<{ revision: number }>('select coalesce(max(revision), 0) + 1 as revision from approval_decisions where project_id = $1 and target_type = $2 and target_id = $3 and target_revision_id = $4', [decision.projectId, decision.targetType, decision.targetId, decision.targetRevisionId]);
    const result = await this.db.query('insert into approval_decisions (id, project_id, target_type, target_id, target_revision_id, revision, schema_version, status, approver, reason, evidence) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) returning *', [`approval-${randomUUID()}`, decision.projectId, decision.targetType, decision.targetId, decision.targetRevisionId, Number(next.rows[0]?.revision || 1), decision.schemaVersion, decision.status, decision.approver, decision.reason || null, JSON.stringify(decision.evidence || {})]);
    return mapApproval(result.rows[0] as Record<string, unknown>);
  }

  async getCurrent(projectId: string, targetType: ApprovalTargetType, targetId: string, targetRevisionId: string): Promise<ApprovalRecord | null> {
    const result = await this.db.query('select * from approval_decisions where project_id = $1 and target_type = $2 and target_id = $3 and target_revision_id = $4 order by revision desc limit 1', [projectId, targetType, targetId, targetRevisionId]);
    return result.rows[0] ? mapApproval(result.rows[0] as Record<string, unknown>) : null;
  }

  async list(projectId: string): Promise<ApprovalRecord[]> {
    const result = await this.db.query('select * from approval_decisions where project_id = $1 order by target_type, target_id, target_revision_id, revision', [projectId]);
    return result.rows.map((row) => mapApproval(row as Record<string, unknown>));
  }

  async approve(projectId: string, targetType: ApprovalTargetType, targetId: string, targetRevisionId: string, approver: string): Promise<ApprovalRecord> { return this.transition(projectId, targetType, targetId, targetRevisionId, approver, 'APPROVED'); }
  async reject(projectId: string, targetType: ApprovalTargetType, targetId: string, targetRevisionId: string, approver: string, reason: string): Promise<ApprovalRecord> { return this.transition(projectId, targetType, targetId, targetRevisionId, approver, 'REJECTED', reason); }

  private async transition(projectId: string, targetType: ApprovalTargetType, targetId: string, targetRevisionId: string, approver: string, status: Exclude<ApprovalStatus, 'PENDING'>, reason?: string): Promise<ApprovalRecord> {
    const current = await this.getCurrent(projectId, targetType, targetId, targetRevisionId);
    if (!current) throw new Error('Approval decision not found');
    if (current.status !== 'PENDING') throw new Error(`Approval decision must be PENDING, got ${current.status}`);
    return this.insert({ projectId, targetType, targetId, targetRevisionId, status, approver, ...(reason !== undefined ? { reason } : {}), evidence: current.evidence });
  }
}
