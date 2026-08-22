import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { validateReviewDecision, type ReviewDecisionV0, type ReviewStatus, type ReviewTargetType } from '../../../contracts/src/index.js';
import { ProjectService } from '../../project/src/index.js';

export interface ReviewRecord {
  id: string;
  projectId: string;
  targetType: ReviewTargetType;
  targetId: string;
  revision: number;
  status: ReviewStatus;
  reviewer: string;
  reason?: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export type ReviewCreateInput = {
  projectId: string;
  targetType: ReviewTargetType;
  targetId: string;
  status: ReviewStatus;
  reviewer: string;
  reason?: string | undefined;
  evidence?: Record<string, unknown> | undefined;
  schemaVersion?: 'REVIEW_V0' | undefined;
};

export type PublishSnapshotApprovalInput = {
  projectId: string;
  targetId: string;
  reviewDecisionId: string;
  snapshotDigest: string;
};
export interface ReviewPublishApprovalProvider { isApproved(input: PublishSnapshotApprovalInput): Promise<boolean>; }

function mapReview(row: Record<string, unknown>): ReviewRecord {
  const evidence = (row.evidence && typeof row.evidence === 'object' ? row.evidence : {}) as Record<string, unknown>;
  return {
    id: String(row.id), projectId: String(row.project_id), targetType: String(row.target_type) as ReviewTargetType,
    targetId: String(row.target_id), revision: Number(row.revision), status: String(row.status) as ReviewStatus,
    reviewer: String(row.reviewer), ...(row.reason ? { reason: String(row.reason) } : {}), evidence,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export class ReviewService {
  constructor(private readonly db: Pool, private readonly projects = new ProjectService(db)) {}

  private async assertProject(projectId: string): Promise<void> {
    if (!(await this.projects.get(projectId))) throw new Error(`Project ${projectId} not found`);
  }

  async create(input: ReviewCreateInput): Promise<ReviewRecord> {
    const decision: ReviewDecisionV0 = {
      schemaVersion: input.schemaVersion || 'REVIEW_V0', projectId: input.projectId, targetType: input.targetType,
      targetId: input.targetId, status: input.status, reviewer: input.reviewer,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    };
    validateReviewDecision(decision);
    await this.assertProject(decision.projectId);
    const next = await this.db.query<{ revision: number }>('select coalesce(max(revision), 0) + 1 as revision from review_decisions where project_id = $1 and target_type = $2 and target_id = $3', [decision.projectId, decision.targetType, decision.targetId]);
    const revision = Number(next.rows[0]?.revision || 1);
    const id = `review-${randomUUID()}`;
    const result = await this.db.query('insert into review_decisions (id, project_id, target_type, target_id, revision, schema_version, status, reviewer, reason, evidence) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) returning *', [id, decision.projectId, decision.targetType, decision.targetId, revision, decision.schemaVersion, decision.status, decision.reviewer, decision.reason || null, JSON.stringify(decision.evidence || {})]);
    return mapReview(result.rows[0] as Record<string, unknown>);
  }

  async getCurrent(projectId: string, targetType: ReviewTargetType, targetId: string): Promise<ReviewRecord | null> {
    const result = await this.db.query('select * from review_decisions where project_id = $1 and target_type = $2 and target_id = $3 order by revision desc limit 1', [projectId, targetType, targetId]);
    return result.rows[0] ? mapReview(result.rows[0] as Record<string, unknown>) : null;
  }

  async list(projectId: string): Promise<ReviewRecord[]> {
    const result = await this.db.query('select * from review_decisions where project_id = $1 order by target_type, target_id, revision', [projectId]);
    return result.rows.map((row) => mapReview(row as Record<string, unknown>));
  }

  async approve(projectId: string, targetType: ReviewTargetType, targetId: string, reviewer: string): Promise<ReviewRecord> {
    if (targetType === 'PUBLISH') {
      const current = await this.getCurrent(projectId, targetType, targetId);
      const snapshotDigest = current?.evidence.snapshotDigest;
      if (typeof snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(snapshotDigest)) throw new Error('PUBLISH review requires an immutable snapshotDigest');
    }
    return this.transition(projectId, targetType, targetId, reviewer, 'APPROVED');
  }

  async isApprovedForPublishSnapshot(input: PublishSnapshotApprovalInput): Promise<boolean> {
    const result = await this.db.query<{ status: string; snapshot_digest: string | null; is_current: boolean }>(
      `select d.status, d.evidence ->> 'snapshotDigest' as snapshot_digest,
        not exists (
          select 1 from review_decisions newer
          where newer.project_id = d.project_id and newer.target_type = d.target_type and newer.target_id = d.target_id and newer.revision > d.revision
        ) as is_current
      from review_decisions d
      where d.id = $1 and d.project_id = $2 and d.target_type = 'PUBLISH' and d.target_id = $3`,
      [input.reviewDecisionId, input.projectId, input.targetId],
    );
    const row = result.rows[0];
    return Boolean(row && row.status === 'APPROVED' && row.is_current && row.snapshot_digest === input.snapshotDigest);
  }

  async reject(projectId: string, targetType: ReviewTargetType, targetId: string, reviewer: string, reason: string): Promise<ReviewRecord> {
    return this.transition(projectId, targetType, targetId, reviewer, 'REJECTED', reason);
  }

  private async transition(projectId: string, targetType: ReviewTargetType, targetId: string, reviewer: string, status: Exclude<ReviewStatus, 'PENDING'>, reason?: string): Promise<ReviewRecord> {
    const current = await this.getCurrent(projectId, targetType, targetId);
    if (!current) throw new Error('Review decision not found');
    if (current.status !== 'PENDING') throw new Error(`Review decision must be PENDING, got ${current.status}`);
    return this.create({ projectId, targetType, targetId, status, reviewer, ...(reason !== undefined ? { reason } : {}), evidence: current.evidence });
  }
}

export function createReviewPublishApprovalProvider(review: ReviewService): ReviewPublishApprovalProvider {
  return { isApproved: (input) => review.isApprovedForPublishSnapshot(input) };
}
