export type ApprovalTargetType = 'RENDER' | 'PUBLISH';
export type LegacyApprovalTargetType = 'SCRIPT' | 'STORYBOARD';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ApprovalDecisionV0 {
  schemaVersion: 'APPROVAL_V0';
  projectId: string;
  targetType: ApprovalTargetType;
  targetId: string;
  targetRevisionId: string;
  status: ApprovalStatus;
  approver: string;
  reason?: string;
  evidence?: Record<string, unknown>;
}

export function validateApprovalDecision(decision: ApprovalDecisionV0): void {
  if (decision.schemaVersion !== 'APPROVAL_V0') throw new Error('Unsupported approval schema');
  if (!decision.projectId.trim()) throw new Error('projectId must be non-empty');
  if (!['RENDER', 'PUBLISH'].includes(decision.targetType)) throw new Error('targetType is not a formal approval target');
  if (!decision.targetId.trim()) throw new Error('targetId must be non-empty');
  if (!decision.targetRevisionId.trim()) throw new Error('targetRevisionId must be non-empty');
  if (!decision.approver.trim()) throw new Error('approver must be non-empty');
  if (!['PENDING', 'APPROVED', 'REJECTED'].includes(decision.status)) throw new Error('status is invalid');
  if (decision.status === 'REJECTED' && !decision.reason?.trim()) throw new Error('reason is required for rejected approval');
}
