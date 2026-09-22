export const PRODUCTION_RUN_TEMPLATE = 'STANDARD_SHORT_VIDEO' as const;
export const PRODUCTION_RUN_STAGES = ['CONTENT', 'VOICE', 'DIGITAL_HUMAN', 'MATERIALS', 'EDITING', 'PREVIEW', 'APPROVAL', 'RENDER', 'PUBLISH', 'REVIEW'] as const;
export type ProductionRunStage = (typeof PRODUCTION_RUN_STAGES)[number];
export const PRODUCTION_RUN_STATUSES = ['DRAFT', 'RUNNING', 'WAITING_USER', 'FAILED', 'COMPLETED', 'COMPLETED_WITHOUT_PUBLISH', 'CANCELLED'] as const;
export type ProductionRunStatus = (typeof PRODUCTION_RUN_STATUSES)[number];
export const PRODUCTION_STEP_STATUSES = ['PENDING', 'RUNNING', 'WAITING_USER', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'] as const;
export type ProductionStepStatus = (typeof PRODUCTION_STEP_STATUSES)[number];
export type DigitalHumanMode = 'NONE' | 'INTRO_ONLY' | 'OUTRO_ONLY' | 'FULL_TALKING_HEAD' | 'CUSTOM';
export type ProductionDomainRefs = Record<string, string | string[]>;

export const PRODUCTION_REF_KEYS = new Set([
  'projectId', 'scriptId', 'scriptRevisionId', 'contentId', 'voiceAssetId', 'speechGenerationId',
  'voiceProfileId', 'avatarGenerationId', 'avatarProfileId', 'avatarClipId', 'digitalHumanAssetId',
  'materialPoolSnapshotId', 'assetId', 'assetIds', 'editSessionId', 'manifestRevisionId', 'manifestId',
  'previewAssetId', 'previewId', 'renderId', 'renderAssetId', 'approvalId', 'publishJobId',
  'publishRequestId', 'externalPostId', 'reviewId', 'jobId',
] as const);

export interface ProductionRunRecord {
  id: string;
  projectId: string;
  title: string;
  template: typeof PRODUCTION_RUN_TEMPLATE;
  status: ProductionRunStatus;
  currentStage: ProductionRunStage;
  digitalHumanMode: DigitalHumanMode;
  approvalRequired: boolean;
  approvalBypassed: boolean;
  metadata: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionRunStepRecord {
  id: string;
  productionRunId: string;
  stage: ProductionRunStage;
  status: ProductionStepStatus;
  attempt: number;
  idempotencyKey: string;
  startedAt: string | null;
  completedAt: string | null;
  staleAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  inputRefs: Record<string, string | string[]>;
  outputRefs: Record<string, string | string[]>;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionRunDetail extends ProductionRunRecord {
  steps: ProductionRunStepRecord[];
  trace: Record<string, string | string[] | null>;
}

export function validateProductionDomainRefs(refs: Record<string, unknown> = {}): ProductionDomainRefs {
  const allowed = new Set<string>(PRODUCTION_REF_KEYS);
  const normalized: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(refs)) {
    if (!allowed.has(key)) throw new Error(`PRODUCTION_REF_KEY_INVALID:${key}`);
    if (typeof value === 'string' && value.trim()) normalized[key] = value.trim();
    else if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim())) normalized[key] = value.map((item) => item.trim());
    else throw new Error(`PRODUCTION_REF_VALUE_INVALID:${key}`);
  }
  return normalized;
}
