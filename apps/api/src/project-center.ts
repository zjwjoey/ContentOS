import type {
  ProjectCenterAction,
  ProjectCenterHealthLevel,
  ProjectCenterStage,
  ProjectCenterStageKey,
  ProjectCenterSnapshot,
} from '../../../packages/contracts/src/index.js';
import type { AssetCatalogService } from '../../../packages/modules/asset/src/index.js';
import type { ApprovalService } from '../../../packages/modules/approval/src/index.js';
import type { DirectorService } from '../../../packages/modules/director/src/index.js';
import type { JobService, JobSummary } from '../../../packages/modules/job/src/index.js';
import type { ProjectRecord, ProjectService } from '../../../packages/modules/project/src/index.js';
import type { PublisherProjectSummary, PublisherService } from '../../../packages/modules/publisher/src/index.js';

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
  const publisherStatus = input.needsHumanActionCount > 0 ? 'ACTION_REQUIRED' : input.hasExternalPost ? 'COMPLETE' : (input.publisherStatusCounts.FAILED || 0) > 0 ? 'BLOCKED' : Object.entries(input.publisherStatusCounts).some(([status, count]) => count > 0 && ['QUEUED', 'PUBLISHING', 'RECONCILING'].includes(status)) ? 'IN_PROGRESS' : Object.values(input.publisherStatusCounts).some((count) => count > 0) ? 'READY' : 'NOT_STARTED';
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

export interface ProjectCenterServiceDependencies {
  projects: ProjectService;
  director: DirectorService;
  assets: AssetCatalogService;
  jobs: JobService;
  approvals: ApprovalService;
  publisher: PublisherService;
}

type ReadResult<T> = { value: T; failed: false } | { value: null; failed: true };

async function read<T>(operation: () => Promise<T>): Promise<ReadResult<T>> {
  try { return { value: await operation(), failed: false }; } catch { return { value: null, failed: true }; }
}

function latestApproval(approvals: Array<{ status: string; createdAt: string }>): string | null {
  return approvals.slice().sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)).at(-1)?.status || null;
}

function buildActions(projectId: string, health: { level: ProjectCenterHealthLevel; reasons: string[] }, approvalStatus: string | null, summary: PublisherProjectSummary, jobs: JobSummary[]): ProjectCenterAction[] {
  const actions: ProjectCenterAction[] = [];
  if (approvalStatus === 'PENDING') actions.push({ id: 'approval-pending', kind: 'APPROVAL', title: '处理待审批内容', detail: '当前版本等待人工审批。', severity: 'WARNING', href: '/projects/' + projectId + '/publisher' });
  if (summary.needsHumanActionCount > 0) actions.push({ id: 'publisher-human-action', kind: 'HUMAN_ACTION', title: '处理发布账号', detail: 'Publisher 有需要人工处理的账号或外部状态。', severity: 'BLOCKED', href: '/projects/' + projectId + '/publisher' });
  for (const job of jobs.filter((item) => ['FAILED', 'BLOCKED'].includes(item.state))) {
    actions.push({ id: 'job-failure-' + job.id, kind: 'JOB_FAILURE', title: '处理失败 Job', detail: job.type + ' 已进入 ' + job.state + '。', severity: 'BLOCKED', href: job.type === 'PUBLISH' ? '/projects/' + projectId + '/publisher' : null });
  }
  if ((summary.statusCounts.FAILED || 0) > 0 && summary.needsHumanActionCount === 0) actions.push({ id: 'publisher-retry', kind: 'PUBLISH_RETRY', title: '检查发布失败请求', detail: 'Publisher 存在失败请求，可进入工作台处理。', severity: 'WARNING', href: '/projects/' + projectId + '/publisher' });
  if (actions.length === 0 && health.level === 'HEALTHY') actions.push({ id: 'open-director', kind: 'NAVIGATION', title: '进入 Director', detail: '继续完善项目内容规划。', severity: 'INFO', href: '/projects/' + projectId + '/director' });
  return actions;
}

function safeProject(project: ProjectRecord): ProjectCenterSnapshot['project'] {
  return { id: project.id, name: project.name, status: project.status, updatedAt: project.updatedAt };
}

export class ProjectCenterService {
  constructor(private readonly dependencies: ProjectCenterServiceDependencies) {}

  async get(projectId: string): Promise<ProjectCenterSnapshot | null> {
    const project = await this.dependencies.projects.get(projectId);
    if (!project) return null;
    const [director, assets, jobs, approvals, publisher] = await Promise.all([
      read(() => this.dependencies.director.list(projectId)),
      read(() => this.dependencies.assets.listPublishable(projectId)),
      read(() => this.dependencies.jobs.listProjectSummaries(projectId)),
      read(() => this.dependencies.approvals.list(projectId)),
      read(() => this.dependencies.publisher.getProjectSummary(projectId)),
    ]);
    const directorRevisions = director.value || [];
    const jobSummaries = jobs.value || [];
    const approvalRecords = approvals.value || [];
    const publisherSummary = publisher.value || {
      projectId,
      accountCount: 0,
      requestCount: 0,
      statusCounts: {} as PublisherProjectSummary['statusCounts'],
      confirmedExternalPostCount: 0,
      needsHumanActionCount: 0,
    };
    const approvalStatus = latestApproval(approvalRecords);
    const ruleInput: ProjectCenterRuleInput = {
      projectId,
      projectStatus: project.status,
      hasDirectorRevision: directorRevisions.length > 0,
      hasApprovedDirector: directorRevisions.some((item) => item.status === 'APPROVED'),
      hasReadyVideo: (assets.value || []).length > 0,
      videoJobStates: jobSummaries.filter((item) => item.type === 'VIDEO_RENDER').map((item) => item.state),
      approvalStatus,
      publisherStatusCounts: publisherSummary.statusCounts,
      needsHumanActionCount: publisherSummary.needsHumanActionCount,
      hasExternalPost: publisherSummary.confirmedExternalPostCount > 0,
      jobs: jobSummaries.map((item) => ({ type: item.type, state: item.state })),
    };
    const health = deriveHealth(ruleInput);
    const stages = deriveStages(ruleInput);
    const failedSources = [
      director.failed ? 'Director' : null,
      assets.failed ? 'Video' : null,
      jobs.failed ? 'Job' : null,
      approvals.failed ? 'Approval' : null,
      publisher.failed ? 'Publisher' : null,
    ].filter((value): value is string => value !== null);
    if (failedSources.length > 0) {
      health.level = 'BLOCKED';
      health.reasons = health.reasons.concat(failedSources.map((source) => source + ' 数据暂时不可用'));
    }
    for (const source of failedSources) {
      const key = source === 'Job' ? 'VIDEO' : source.toUpperCase() as ProjectCenterStageKey;
      const stageToUpdate = stages.find((item) => item.key === key);
      if (stageToUpdate) {
        stageToUpdate.status = 'BLOCKED';
        stageToUpdate.summary = source + ' 数据暂时不可用';
      }
    }
    return {
      project: safeProject(project),
      health,
      stages,
      currentStage: deriveCurrentStage(stages),
      actions: buildActions(projectId, health, approvalStatus, publisherSummary, jobSummaries),
      recentJobs: jobSummaries.map((job) => ({ id: job.id, type: job.type, state: job.state, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts, createdAt: job.createdAt })),
    };
  }
}
