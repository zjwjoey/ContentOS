import type {
  ProjectCenterHealthLevel,
  ProjectCenterStage,
  ProjectCenterStageKey,
  ProjectCenterSnapshot,
} from '../../../packages/contracts/src/index.js';

export interface ProjectCenterRuleInput {
  projectId: string;
  projectStatus: string;
  hasDirectorRevision: boolean;
  hasApprovedDirector: boolean;
  hasReadyVideo: boolean;
  videoJobStates: string[];
  approvalStatus: string | null;
  publisherStatusCounts: Record<string, number>;
  needsHumanActionCount: number;
  hasExternalPost: boolean;
  jobs: Array<{ state: string; type: string }>;
}

function hasJob(input: ProjectCenterRuleInput, states: string[]): boolean {
  return input.jobs.some((job) => states.includes(job.state)) || input.videoJobStates.some((state) => states.includes(state));
}

export function deriveHealth(input: ProjectCenterRuleInput): { level: ProjectCenterHealthLevel; reasons: string[] } {
  const reasons: string[] = [];
  if (hasJob(input, ['FAILED', 'BLOCKED'])) reasons.push('存在失败或阻塞 Job');
  if (input.needsHumanActionCount > 0) reasons.push('Publisher 需要人工处理');
  if (input.approvalStatus === 'REJECTED') reasons.push('当前审批已驳回');
  if (reasons.length > 0) return { level: 'BLOCKED', reasons };
  if (input.projectStatus === 'PUBLISHED') return { level: 'COMPLETE', reasons: [] };
  if (input.approvalStatus === 'PENDING') reasons.push('存在待处理审批');
  if (hasJob(input, ['QUEUED', 'RUNNING', 'RETRY_WAIT'])) reasons.push('存在运行中的异步 Job');
  if (Object.entries(input.publisherStatusCounts).some(([status, count]) => count > 0 && ['DRAFT', 'SCHEDULED', 'FAILED'].includes(status))) reasons.push('Publisher 存在待处理请求');
  return reasons.length > 0 ? { level: 'ATTENTION', reasons } : { level: 'HEALTHY', reasons: [] };
}

function stage(key: ProjectCenterStageKey, status: ProjectCenterStage['status'], projectId: string, summary: string): ProjectCenterStage {
  const href = key === 'DIRECTOR' ? '/projects/' + projectId + '/director' : key === 'PUBLISHER' ? '/projects/' + projectId + '/publisher' : null;
  return { key, status, label: { DIRECTOR: 'Director', VIDEO: 'Video', APPROVAL: 'Approval', PUBLISHER: 'Publisher' }[key], href, summary };
}

export function deriveStages(input: ProjectCenterRuleInput): ProjectCenterStage[] {
  const directorStatus = input.hasApprovedDirector ? 'COMPLETE' : input.hasDirectorRevision ? 'IN_PROGRESS' : 'NOT_STARTED';
  const videoStatus = hasJob(input, ['FAILED', 'BLOCKED']) ? 'BLOCKED' : input.hasReadyVideo ? 'READY' : hasJob(input, ['QUEUED', 'RUNNING', 'RETRY_WAIT']) ? 'IN_PROGRESS' : 'NOT_STARTED';
  const approvalStatus = input.approvalStatus === 'REJECTED' ? 'BLOCKED' : input.approvalStatus === 'APPROVED' ? 'COMPLETE' : input.approvalStatus === 'PENDING' ? 'ACTION_REQUIRED' : 'NOT_STARTED';
  const publisherStatus = input.needsHumanActionCount > 0 ? 'ACTION_REQUIRED' : input.hasExternalPost ? 'COMPLETE' : Object.entries(input.publisherStatusCounts).some(([status, count]) => count > 0 && ['QUEUED', 'PUBLISHING', 'RECONCILING'].includes(status)) ? 'IN_PROGRESS' : Object.values(input.publisherStatusCounts).some((count) => count > 0) ? 'READY' : 'NOT_STARTED';
  return [
    stage('DIRECTOR', directorStatus, input.projectId, directorStatus === 'COMPLETE' ? '已批准 Director 版本' : directorStatus === 'IN_PROGRESS' ? 'Director 仍在准备' : '尚未创建 Director 版本'),
    stage('VIDEO', videoStatus, input.projectId, videoStatus === 'READY' ? '已有可发布成片' : videoStatus === 'BLOCKED' ? '视频 Job 失败，需要处理' : videoStatus === 'IN_PROGRESS' ? '视频正在处理中' : '尚未生成成片'),
    stage('APPROVAL', approvalStatus, input.projectId, approvalStatus === 'COMPLETE' ? '当前版本已审批' : approvalStatus === 'ACTION_REQUIRED' ? '等待人工审批' : approvalStatus === 'BLOCKED' ? '审批已驳回' : '尚无当前审批'),
    stage('PUBLISHER', publisherStatus, input.projectId, publisherStatus === 'COMPLETE' ? '已确认外部发布' : publisherStatus === 'ACTION_REQUIRED' ? '需要人工处理发布账号' : publisherStatus === 'IN_PROGRESS' ? '发布任务处理中' : publisherStatus === 'READY' ? '已有发布请求' : '尚无发布请求'),
  ];
}

export function deriveCurrentStage(stages: ProjectCenterStage[]): ProjectCenterStageKey | null {
  return stages.find((item) => !['COMPLETE', 'READY'].includes(item.status))?.key || (stages.length > 0 ? 'PUBLISHER' : null);
}

export type { ProjectCenterHealthLevel, ProjectCenterSnapshot };

