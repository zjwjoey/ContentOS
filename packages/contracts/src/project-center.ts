export type ProjectCenterHealthLevel = 'HEALTHY' | 'ATTENTION' | 'BLOCKED' | 'COMPLETE';
export type ProjectCenterStageKey = 'ASSETS' | 'DIRECTOR' | 'VIDEO' | 'APPROVAL' | 'PUBLISHER';
export type ProjectCenterStageStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'ACTION_REQUIRED' | 'READY' | 'COMPLETE' | 'BLOCKED';
export type ProjectCenterActionKind = 'APPROVAL' | 'JOB_FAILURE' | 'HUMAN_ACTION' | 'PUBLISH_RETRY' | 'NAVIGATION';
export type ProjectCenterSeverity = 'INFO' | 'WARNING' | 'BLOCKED';

export interface ProjectCenterStage {
  key: ProjectCenterStageKey;
  status: ProjectCenterStageStatus;
  label: string;
  href: string | null;
  summary: string;
}

export interface ProjectCenterAction {
  id: string;
  kind: ProjectCenterActionKind;
  title: string;
  detail: string;
  severity: ProjectCenterSeverity;
  href: string | null;
}

export interface ProjectCenterJobSummary {
  id: string;
  type: string;
  state: string;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
}

export interface ProjectCenterSnapshot {
  project: { id: string; name: string; status: string; updatedAt: string };
  health: { level: ProjectCenterHealthLevel; reasons: string[] };
  stages: ProjectCenterStage[];
  currentStage: ProjectCenterStageKey | null;
  currentStageSummary: string | null;
  actions: ProjectCenterAction[];
  recentJobs: ProjectCenterJobSummary[];
}
