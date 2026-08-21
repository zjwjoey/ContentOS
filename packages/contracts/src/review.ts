export type ReviewTargetType = 'RENDER' | 'PUBLISH';
export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export interface ReviewDecisionV0 {
  schemaVersion: 'REVIEW_V0';
  projectId: string;
  targetType: ReviewTargetType;
  targetId: string;
  status: ReviewStatus;
  reviewer: string;
  reason?: string;
  evidence?: Record<string, unknown>;
}

export function validateReviewDecision(decision: ReviewDecisionV0): void {
  if (decision.schemaVersion !== 'REVIEW_V0') throw new Error('Unsupported review schema');
  if (!decision.projectId.trim()) throw new Error('projectId must be non-empty');
  if (!['RENDER', 'PUBLISH'].includes(decision.targetType)) throw new Error('targetType is invalid');
  if (!decision.targetId.trim()) throw new Error('targetId must be non-empty');
  if (!decision.reviewer.trim()) throw new Error('reviewer must be non-empty');
  if (!['PENDING', 'APPROVED', 'REJECTED'].includes(decision.status)) throw new Error('status is invalid');
  if (decision.status === 'REJECTED' && !decision.reason?.trim()) throw new Error('reason is required for rejected review');
}
