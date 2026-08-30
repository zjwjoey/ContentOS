import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  validateApprovalDecision,
  type ApprovalDecisionV0,
  type ApprovalStatus,
  type ApprovalTargetType,
  type LegacyApprovalTargetType,
} from '../../../contracts/src/index.js';
import { ProjectService } from '../../project/src/index.js';

export interface ApprovalRecord {
  id: string;
  projectId: string;
  targetType: ApprovalTargetType | LegacyApprovalTargetType;
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
  targetType: ApprovalTargetType | LegacyApprovalTargetType;
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
    id: String(row.id),
    projectId: String(row.project_id),
    targetType: String(row.target_type) as ApprovalTargetType,
    targetId: String(row.target_id),
    targetRevisionId: String(row.target_revision_id),
    revision: Number(row.revision),
    status: String(row.status) as ApprovalStatus,
    approver: String(row.approver),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    evidence: row.evidence && typeof row.evidence === 'object' ? (row.evidence as Record<string, unknown>) : {},
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export class ApprovalService {
  constructor(
    private readonly db: Pool,
    private readonly projects = new ProjectService(db),
  ) {}

  private async assertProject(projectId: string): Promise<void> {
    if (!(await this.projects.get(projectId))) throw new Error(`Project ${projectId} not found`);
  }

  private lockKey(decision: Pick<ApprovalDecisionV0, 'projectId' | 'targetType' | 'targetId' | 'targetRevisionId'>): string {
    return `${decision.projectId}:${decision.targetType}:${decision.targetId}:${decision.targetRevisionId}`;
  }

  private async insertDecision(client: PoolClient, decision: ApprovalDecisionV0): Promise<ApprovalRecord> {
    const next = await client.query<{ revision: number }>(
      'select coalesce(max(revision), 0) + 1 as revision from approval_decisions where project_id = $1 and target_type = $2 and target_id = $3 and target_revision_id = $4',
      [decision.projectId, decision.targetType, decision.targetId, decision.targetRevisionId],
    );
    const result = await client.query(
      'insert into approval_decisions (id, project_id, target_type, target_id, target_revision_id, revision, schema_version, status, approver, reason, evidence) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) returning *',
      [
        `approval-${randomUUID()}`,
        decision.projectId,
        decision.targetType,
        decision.targetId,
        decision.targetRevisionId,
        Number(next.rows[0]?.revision || 1),
        decision.schemaVersion,
        decision.status,
        decision.approver,
        decision.reason || null,
        JSON.stringify(decision.evidence || {}),
      ],
    );
    return mapApproval(result.rows[0] as Record<string, unknown>);
  }

  private async assertTarget(client: PoolClient, decision: ApprovalDecisionV0): Promise<void> {
    const result =
      decision.targetType === 'RENDER'
        ? await client.query(
            "select r.id from renders r join edit_manifests m on m.id = r.manifest_id and m.project_id = r.project_id where r.id = $1 and r.project_id = $2 and r.output_asset_id = $3 and r.status = 'SUCCEEDED' and m.status = 'PERSISTED' limit 1",
            [decision.targetId, decision.projectId, decision.targetRevisionId],
          )
        : await client.query(
            'select p.id from publisher_requests p join publisher_request_revisions r on r.id = p.current_revision_id and r.request_id = p.id where p.id = $1 and p.project_id = $2 and r.id = $3 limit 1',
            [decision.targetId, decision.projectId, decision.targetRevisionId],
          );
    if (result.rows.length === 0) throw new Error(`${decision.targetType} approval target is not the current project artifact`);
  }

  private async beginDecisionTransaction(client: PoolClient, decision: ApprovalDecisionV0): Promise<void> {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [this.lockKey(decision)]);
  }

  async create(input: ApprovalCreateInput): Promise<ApprovalRecord> {
    const decision = {
      schemaVersion: input.schemaVersion || 'APPROVAL_V0',
      projectId: input.projectId,
      targetType: input.targetType,
      targetId: input.targetId,
      targetRevisionId: input.targetRevisionId,
      status: input.status,
      approver: input.approver,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    } as ApprovalDecisionV0;
    validateApprovalDecision(decision);
    if (decision.status !== 'PENDING') throw new Error('Approval creation only supports PENDING decisions');
    await this.assertProject(decision.projectId);
    const client = await this.db.connect();
    try {
      await this.beginDecisionTransaction(client, decision);
      await this.assertTarget(client, decision);
      const record = await this.insertDecision(client, decision);
      await client.query('commit');
      return record;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        /* preserve original transaction error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getCurrent(projectId: string, targetType: ApprovalTargetType, targetId: string, targetRevisionId: string): Promise<ApprovalRecord | null> {
    const result = await this.db.query(
      'select * from approval_decisions where project_id = $1 and target_type = $2 and target_id = $3 and target_revision_id = $4 order by revision desc limit 1',
      [projectId, targetType, targetId, targetRevisionId],
    );
    return result.rows[0] ? mapApproval(result.rows[0] as Record<string, unknown>) : null;
  }

  async list(projectId: string): Promise<ApprovalRecord[]> {
    const result = await this.db.query('select * from approval_decisions where project_id = $1 order by target_type, target_id, target_revision_id, revision', [
      projectId,
    ]);
    return result.rows.map((row) => mapApproval(row as Record<string, unknown>));
  }

  async approve(projectId: string, targetType: ApprovalTargetType, targetId: string, targetRevisionId: string, approver: string): Promise<ApprovalRecord> {
    return this.transition(projectId, targetType, targetId, targetRevisionId, approver, 'APPROVED');
  }
  async reject(
    projectId: string,
    targetType: ApprovalTargetType,
    targetId: string,
    targetRevisionId: string,
    approver: string,
    reason: string,
  ): Promise<ApprovalRecord> {
    return this.transition(projectId, targetType, targetId, targetRevisionId, approver, 'REJECTED', reason);
  }

  private async transition(
    projectId: string,
    targetType: ApprovalTargetType,
    targetId: string,
    targetRevisionId: string,
    approver: string,
    status: Exclude<ApprovalStatus, 'PENDING'>,
    reason?: string,
  ): Promise<ApprovalRecord> {
    const decision: ApprovalDecisionV0 = {
      schemaVersion: 'APPROVAL_V0',
      projectId,
      targetType,
      targetId,
      targetRevisionId,
      status,
      approver,
      ...(reason !== undefined ? { reason } : {}),
    };
    validateApprovalDecision(decision);
    await this.assertProject(projectId);
    const client = await this.db.connect();
    try {
      await this.beginDecisionTransaction(client, decision);
      const currentResult = await client.query(
        'select * from approval_decisions where project_id = $1 and target_type = $2 and target_id = $3 and target_revision_id = $4 order by revision desc limit 1',
        [projectId, targetType, targetId, targetRevisionId],
      );
      const current = currentResult.rows[0] ? mapApproval(currentResult.rows[0] as Record<string, unknown>) : null;
      if (!current) throw new Error('Approval decision not found');
      if (current.status !== 'PENDING') throw new Error(`Approval decision must be PENDING, got ${current.status}`);
      const record = await this.insertDecision(client, { ...decision, evidence: current.evidence });
      await client.query('commit');
      return record;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        /* preserve original transaction error */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
