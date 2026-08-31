import type {
  ProjectCenterAction,
  ProjectCenterHealthLevel,
  ProjectCenterStage,
  ProjectCenterStageKey,
  ProjectCenterSnapshot,
} from '../../../packages/contracts/src/index.js';
import type { AssetCatalogService } from '../../../packages/modules/asset/src/index.js';
import type { ApprovalService } from '../../../packages/modules/approval/src/index.js';
import type { DirectorProjectReadService } from '../../../packages/modules/director/src/index.js';
import type { JobService, JobSummary, ProjectJobStateSummary } from '../../../packages/modules/job/src/index.js';
import type { ProjectRecord, ProjectService } from '../../../packages/modules/project/src/index.js';
import type { PublisherProjectSummary, PublisherService } from '../../../packages/modules/publisher/src/index.js';
import type { VideoProjectReadService } from '../../../packages/modules/video/src/index.js';

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
  jobStateCounts?: Record<string, number>;
  videoJobStateCounts?: Record<string, number>;
  approvalStatuses?: string[];
}

function hasJob(input: ProjectCenterRuleInput, states: string[]): boolean {
  return input.jobs.some((job) => states.includes(job.state)) || input.videoJobStates.some((state) => states.includes(state)) || states.some((state) => (input.jobStateCounts?.[state] || 0) > 0);
}

function hasVideoJob(input: ProjectCenterRuleInput, states: string[]): boolean {
  return input.jobs.some((job) => job.type === 'VIDEO_RENDER' && states.includes(job.state)) || input.videoJobStates.some((state) => states.includes(state)) || states.some((state) => (input.videoJobStateCounts?.[state] || 0) > 0);
}

const publisherInFlightStatuses = new Set(['QUEUED', 'PUBLISHING', 'RECONCILING']);
const publisherAttentionStatuses = new Set(['DRAFT', 'SCHEDULED', ...publisherInFlightStatuses]);

export function deriveHealth(input: ProjectCenterRuleInput): { level: ProjectCenterHealthLevel; reasons: string[] } {
  const reasons: string[] = [];
  if (hasJob(input, ['FAILED', 'BLOCKED'])) reasons.push('存在失败或阻塞 Job');
  if (input.needsHumanActionCount > 0) reasons.push('Publisher 需要人工处理');
  if ((input.publisherStatusCounts.FAILED || 0) > 0) reasons.push('Publisher 存在失败请求');
  if (input.approvalStatus === 'REJECTED' || input.approvalStatuses?.includes('REJECTED')) reasons.push('当前审批已驳回');
  if (reasons.length > 0) return { level: 'BLOCKED', reasons };
  if (input.approvalStatus === 'PENDING' || input.approvalStatuses?.includes('PENDING')) reasons.push('存在待处理审批');
  if (input.approvalStatus === 'IN_PROGRESS') reasons.push('当前审批尚未完整');
  if (hasJob(input, ['QUEUED', 'RUNNING', 'RETRY_WAIT'])) reasons.push('存在运行中的异步 Job');
  if (Object.entries(input.publisherStatusCounts).some(([status, count]) => count > 0 && publisherAttentionStatuses.has(status))) reasons.push('Publisher 存在待处理请求');
  if (reasons.length > 0) return { level: 'ATTENTION', reasons };
  if (input.projectStatus === 'PUBLISHED') return { level: 'COMPLETE', reasons: [] };
  return { level: 'HEALTHY', reasons: [] };
}

function stage(key: ProjectCenterStageKey, status: ProjectCenterStage['status'], projectId: string, summary: string): ProjectCenterStage {
  const href = key === 'DIRECTOR' ? '/projects/' + projectId + '/director' : key === 'PUBLISHER' ? '/projects/' + projectId + '/publisher' : null;
  return { key, status, label: { DIRECTOR: 'Director', VIDEO: 'Video', APPROVAL: 'Approval', PUBLISHER: 'Publisher' }[key], href, summary };
}

export function deriveStages(input: ProjectCenterRuleInput): ProjectCenterStage[] {
  const directorStatus = input.hasApprovedDirector ? 'COMPLETE' : input.hasDirectorRevision ? 'IN_PROGRESS' : 'NOT_STARTED';
  const videoStatus = hasVideoJob(input, ['FAILED', 'BLOCKED']) ? 'BLOCKED' : hasVideoJob(input, ['QUEUED', 'RUNNING', 'RETRY_WAIT']) ? 'IN_PROGRESS' : input.hasReadyVideo ? 'READY' : 'NOT_STARTED';
  const approvalStatus = input.approvalStatus === 'REJECTED' || input.approvalStatuses?.includes('REJECTED') ? 'BLOCKED' : input.approvalStatus === 'PENDING' || input.approvalStatuses?.includes('PENDING') ? 'ACTION_REQUIRED' : input.approvalStatus === 'IN_PROGRESS' ? 'IN_PROGRESS' : input.approvalStatus === 'APPROVED' ? 'COMPLETE' : 'NOT_STARTED';
  const hasActivePublisherRequest = Object.entries(input.publisherStatusCounts).some(([status, count]) => status !== 'CANCELLED' && count > 0);
  const publisherStatus = input.needsHumanActionCount > 0 ? 'ACTION_REQUIRED' : (input.publisherStatusCounts.FAILED || 0) > 0 ? 'BLOCKED' : Object.entries(input.publisherStatusCounts).some(([status, count]) => count > 0 && publisherInFlightStatuses.has(status)) ? 'IN_PROGRESS' : Object.entries(input.publisherStatusCounts).some(([status, count]) => count > 0 && ['DRAFT', 'SCHEDULED'].includes(status)) ? 'READY' : input.hasExternalPost ? 'COMPLETE' : hasActivePublisherRequest ? 'READY' : 'NOT_STARTED';
  return [
    stage('DIRECTOR', directorStatus, input.projectId, directorStatus === 'COMPLETE' ? '已批准 Director 版本' : directorStatus === 'IN_PROGRESS' ? 'Director 仍在准备' : '尚未创建 Director 版本'),
    stage('VIDEO', videoStatus, input.projectId, videoStatus === 'READY' ? '已有可发布成片' : videoStatus === 'BLOCKED' ? '视频 Job 失败，需要处理' : videoStatus === 'IN_PROGRESS' ? '视频正在处理中' : '尚未生成成片'),
    stage('APPROVAL', approvalStatus, input.projectId, approvalStatus === 'COMPLETE' ? '当前版本已审批' : approvalStatus === 'ACTION_REQUIRED' ? '等待人工审批' : approvalStatus === 'IN_PROGRESS' ? '当前版本审批尚未完整' : approvalStatus === 'BLOCKED' ? '审批已驳回' : '尚无当前审批'),
    stage('PUBLISHER', publisherStatus, input.projectId, publisherStatus === 'COMPLETE' ? '已确认外部发布' : publisherStatus === 'ACTION_REQUIRED' ? '需要人工处理发布账号' : publisherStatus === 'IN_PROGRESS' ? '发布任务处理中' : publisherStatus === 'READY' ? '已有发布请求' : '尚无发布请求'),
  ];
}

export function deriveCurrentStage(stages: ProjectCenterStage[]): ProjectCenterStageKey | null {
  return stages.find((item) => !['COMPLETE', 'READY'].includes(item.status))?.key || (stages.length > 0 ? 'PUBLISHER' : null);
}

export type { ProjectCenterHealthLevel, ProjectCenterSnapshot };

export interface ProjectCenterServiceDependencies {
  projects: ProjectService;
  director: DirectorProjectReadService;
  assets: AssetCatalogService;
  jobs: JobService;
  approvals: ApprovalService;
  publisher: PublisherService;
  video: VideoProjectReadService;
}

type ReadResult<T> = { value: T; failed: false } | { value: null; failed: true };

async function read<T>(operation: () => Promise<T>): Promise<ReadResult<T>> {
  try { return { value: await operation(), failed: false }; } catch { return { value: null, failed: true }; }
}

type CurrentApprovalSummary = { targetType: string; targetId: string; targetRevisionId: string; status: string };
type CurrentApprovalTarget = { key: string; targetType: string; targetId: string; targetRevisionId: string };
export type CurrentDirectorApprovalTargets = {
  script?: { targetId: string; targetRevisionId: string };
  storyboard?: { targetId: string; targetRevisionId: string };
};

export function currentApprovalRecords(approvals: Array<{ targetType: string; targetId: string; targetRevisionId: string; status: string; revision: number; createdAt: string }>, currentPublisherRevisionKeys: Set<string>, _currentRenderRevisionId: string | null, currentDirectorTargets: CurrentDirectorApprovalTargets = {}, currentRenderTarget?: { targetId: string; targetRevisionId: string }): CurrentApprovalSummary[] {
  const current = new Map<string, { revision: number; createdAt: string; summary: CurrentApprovalSummary }>();
  for (const approval of approvals) {
    const key = approval.targetType + ':' + approval.targetId + ':' + approval.targetRevisionId;
    if (approval.targetType === 'PUBLISH' && !currentPublisherRevisionKeys.has(key)) continue;
    if (approval.targetType === 'RENDER' && currentRenderTarget && key !== 'RENDER:' + currentRenderTarget.targetId + ':' + currentRenderTarget.targetRevisionId) continue;
    if (approval.targetType === 'RENDER' && !currentRenderTarget) continue;
    if (approval.targetType === 'SCRIPT' && (!currentDirectorTargets.script || key !== 'SCRIPT:' + currentDirectorTargets.script.targetId + ':' + currentDirectorTargets.script.targetRevisionId)) continue;
    if (approval.targetType === 'STORYBOARD' && (!currentDirectorTargets.storyboard || key !== 'STORYBOARD:' + currentDirectorTargets.storyboard.targetId + ':' + currentDirectorTargets.storyboard.targetRevisionId)) continue;
    const previous = current.get(key);
    if (!previous || approval.revision > previous.revision || (approval.revision === previous.revision && approval.createdAt > previous.createdAt)) current.set(key, { revision: approval.revision, createdAt: approval.createdAt, summary: { targetType: approval.targetType, targetId: approval.targetId, targetRevisionId: approval.targetRevisionId, status: approval.status } });
  }
  return [...current.values()].map((item) => item.summary);
}

function currentApprovalStatuses(approvals: CurrentApprovalSummary[]): string[] {
  return approvals.map((approval) => approval.status);
}

function approvalTargetStatuses(targets: CurrentApprovalTarget[], approvals: CurrentApprovalSummary[]): Array<{ targetType: string; status: string }> {
  const decisions = new Map(approvals.map((approval) => [approval.targetType + ':' + approval.targetId + ':' + approval.targetRevisionId, approval.status]));
  return targets.map((target) => ({ targetType: target.targetType, status: decisions.get(target.key) || 'MISSING' }));
}

function approvalState(targetStatuses: Array<{ status: string }>): string | null {
  if (targetStatuses.length === 0) return null;
  const statuses = targetStatuses.map((target) => target.status);
  if (statuses.includes('REJECTED')) return 'REJECTED';
  if (statuses.includes('PENDING')) return 'PENDING';
  if (statuses.every((status) => status === 'APPROVED')) return 'APPROVED';
  return 'IN_PROGRESS';
}

export function buildActions(projectId: string, health: { level: ProjectCenterHealthLevel; reasons: string[] }, approvalStatus: string | null, summary: PublisherProjectSummary, jobs: JobSummary[], failedSources: string[] = [], jobStateCounts: Record<string, number> = {}, historicalJobs: JobSummary[] = [], approvalStatuses: string[] = [], approvalTargets: Array<{ targetType: string; status: string }> = []): ProjectCenterAction[] {
  const actions: ProjectCenterAction[] = [];
  for (const source of failedSources) actions.push({ id: 'source-unavailable-' + source, kind: 'NAVIGATION', title: source + ' 数据暂时不可用', detail: '请刷新项目总控或进入项目页面继续检查。', severity: 'BLOCKED', href: '/projects/' + projectId });
  const approvalActionHref = (targetType: string): string | null => targetType === 'PUBLISH' ? '/projects/' + projectId + '/publisher' : ['SCRIPT', 'STORYBOARD'].includes(targetType) ? '/projects/' + projectId + '/director' : null;
    const addApprovalAction = (status: string, targetType: string): void => {
      const suffix = targetType === 'PUBLISH' ? '' : '-' + targetType;
      if (status === 'PENDING') actions.push({ id: 'approval-pending' + suffix, kind: 'APPROVAL', title: '处理待审批内容', detail: targetType + ' 当前版本等待人工审批。', severity: 'WARNING', href: approvalActionHref(targetType) });
      if (status === 'REJECTED') actions.push({ id: 'approval-rejected' + suffix, kind: 'APPROVAL', title: '处理被驳回审批', detail: targetType + ' 当前版本审批未通过，请检查并更新内容。', severity: 'BLOCKED', href: approvalActionHref(targetType) });
      if (status === 'MISSING') actions.push({ id: 'approval-missing' + suffix, kind: 'APPROVAL', title: '补充当前版本审批', detail: targetType + ' 当前版本尚未形成审批决定。', severity: 'WARNING', href: approvalActionHref(targetType) });
  };
  if (approvalTargets.length > 0) {
    for (const targetType of [...new Set(approvalTargets.map((target) => target.targetType))]) {
      for (const status of [...new Set(approvalTargets.filter((target) => target.targetType === targetType).map((target) => target.status))]) addApprovalAction(status, targetType);
    }
  } else {
    if (approvalStatus === 'PENDING' || approvalStatuses.includes('PENDING')) addApprovalAction('PENDING', 'PUBLISH');
    if (approvalStatus === 'REJECTED' || approvalStatuses.includes('REJECTED')) addApprovalAction('REJECTED', 'PUBLISH');
  }
  if (summary.needsHumanActionCount > 0) actions.push({ id: 'publisher-human-action', kind: 'HUMAN_ACTION', title: '处理发布账号', detail: 'Publisher 有需要人工处理的账号或外部状态。', severity: 'BLOCKED', href: '/projects/' + projectId + '/publisher' });
  const recentFailureIds = new Set<string>();
  for (const job of [...jobs, ...historicalJobs].filter((item) => ['FAILED', 'BLOCKED'].includes(item.state))) {
    if (recentFailureIds.has(job.id)) continue;
    recentFailureIds.add(job.id);
    actions.push({ id: 'job-failure-' + job.id, kind: 'JOB_FAILURE', title: '处理失败 Job', detail: job.id + ' · ' + job.type + ' 已进入 ' + job.state + '。', severity: 'BLOCKED', href: job.type === 'PUBLISH' ? '/projects/' + projectId + '/publisher' : null });
  }
  const recentFailureCount = recentFailureIds.size;
  const unresolvedFailureCount = (jobStateCounts.FAILED || 0) + (jobStateCounts.BLOCKED || 0);
  if (unresolvedFailureCount > recentFailureCount) actions.push({ id: 'job-failure-aggregate', kind: 'JOB_FAILURE', title: '还有历史失败 Job', detail: '还有 ' + (unresolvedFailureCount - recentFailureCount) + ' 个较早的失败或阻塞 Job 未显示在最近列表中，请继续检查 Job 状态。', severity: 'BLOCKED', href: null });
  if ((summary.statusCounts.FAILED || 0) > 0 && summary.needsHumanActionCount === 0) actions.push({ id: 'publisher-retry', kind: 'PUBLISH_RETRY', title: '检查发布失败请求', detail: 'Publisher 存在失败请求，可进入工作台处理。', severity: 'WARNING', href: '/projects/' + projectId + '/publisher' });
  if (actions.length === 0 && health.level === 'HEALTHY') actions.push({ id: 'open-director', kind: 'NAVIGATION', title: '进入 Director', detail: '继续完善项目内容规划。', severity: 'INFO', href: '/projects/' + projectId + '/director' });
  return actions;
}

function safeProject(project: ProjectRecord): ProjectCenterSnapshot['project'] {
  const metadata = project.metadata && typeof project.metadata === 'object' && !Array.isArray(project.metadata) ? project.metadata as Record<string, unknown> : {};
  const safeMetadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => ['topic', 'targetPlatform', 'targetAccount', 'plannedDate', 'contentType', 'tone', 'keywords', 'createdBy'].includes(key)));
  return { id: project.id, name: project.name, status: project.status, updatedAt: project.updatedAt, metadata: safeMetadata };
}

export class ProjectCenterService {
  constructor(private readonly dependencies: ProjectCenterServiceDependencies) {}

  async get(projectId: string): Promise<ProjectCenterSnapshot | null> {
    const project = await this.dependencies.projects.get(projectId);
    if (!project) return null;
    const [director, assets, currentRender, jobs, failedJobs, jobStates, approvals, publisher, publisherRequests] = await Promise.all([
      read(() => this.dependencies.director.get(projectId)),
      read(() => this.dependencies.assets.listPublishable(projectId)),
      read(() => this.dependencies.video.getCurrentRender(projectId)),
      read(() => this.dependencies.jobs.listProjectSummaries(projectId)),
      read(() => this.dependencies.jobs.listProjectFailedSummaries(projectId)),
      read(() => this.dependencies.jobs.getProjectStateSummary(projectId)),
      read(() => this.dependencies.approvals.list(projectId)),
      read(() => this.dependencies.publisher.getProjectSummary(projectId)),
      read(() => this.dependencies.publisher.listRequests(projectId)),
    ]);
    const directorSummary = director.value;
    const jobSummaries = jobs.value || [];
    const jobStateSummary: ProjectJobStateSummary = jobStates.value || { stateCounts: {}, videoStateCounts: {} };
    const approvalRecords = approvals.value || [];
    const publisherSummary = publisher.value || {
      projectId,
      accountCount: 0,
      requestCount: 0,
      statusCounts: {} as PublisherProjectSummary['statusCounts'],
      confirmedExternalPostCount: 0,
      needsHumanActionCount: 0,
    };
    const currentPublisherTargets: CurrentApprovalTarget[] = (publisherRequests.value || []).filter((request) => request.status !== 'CANCELLED' && request.currentRevisionId).map((request) => ({ key: 'PUBLISH:' + request.id + ':' + request.currentRevisionId, targetType: 'PUBLISH', targetId: request.id, targetRevisionId: request.currentRevisionId! }));
    const currentPublisherRevisionKeys = new Set(currentPublisherTargets.map((target) => target.key));
    const currentDirectorTargets = directorSummary?.source === 'V1' ? {
      ...(directorSummary.activeScript ? { script: { targetId: directorSummary.activeScript.aggregateId, targetRevisionId: directorSummary.activeScript.revisionId } } : {}),
      ...(directorSummary.activeStoryboard ? { storyboard: { targetId: directorSummary.activeStoryboard.aggregateId, targetRevisionId: directorSummary.activeStoryboard.revisionId } } : {}),
    } : {};
    const currentRenderTarget = currentRender.value && (assets.value || []).some((asset) => asset.id === currentRender.value?.outputAssetId) ? currentRender.value : undefined;
    const currentRenderApprovalTarget = currentRenderTarget ? { targetId: currentRenderTarget.renderId, targetRevisionId: currentRenderTarget.outputAssetId } : undefined;
    const currentApprovals = currentApprovalRecords(approvalRecords, currentPublisherRevisionKeys, null, currentDirectorTargets, currentRenderApprovalTarget);
    const currentApprovalTargets: CurrentApprovalTarget[] = [
      ...currentPublisherTargets,
      ...(currentDirectorTargets.script ? [{ key: 'SCRIPT:' + currentDirectorTargets.script.targetId + ':' + currentDirectorTargets.script.targetRevisionId, targetType: 'SCRIPT', targetId: currentDirectorTargets.script.targetId, targetRevisionId: currentDirectorTargets.script.targetRevisionId }] : []),
      ...(currentDirectorTargets.storyboard ? [{ key: 'STORYBOARD:' + currentDirectorTargets.storyboard.targetId + ':' + currentDirectorTargets.storyboard.targetRevisionId, targetType: 'STORYBOARD', targetId: currentDirectorTargets.storyboard.targetId, targetRevisionId: currentDirectorTargets.storyboard.targetRevisionId }] : []),
      ...(currentRenderApprovalTarget ? [{ key: 'RENDER:' + currentRenderApprovalTarget.targetId + ':' + currentRenderApprovalTarget.targetRevisionId, targetType: 'RENDER', targetId: currentRenderApprovalTarget.targetId, targetRevisionId: currentRenderApprovalTarget.targetRevisionId }] : []),
    ];
    const currentApprovalTargetStatuses = approvals.failed ? [] : approvalTargetStatuses(currentApprovalTargets, currentApprovals);
    const approvalStatuses = currentApprovalTargetStatuses.map((target) => target.status);
    const approvalStatus = approvalState(currentApprovalTargetStatuses);
    const ruleInput: ProjectCenterRuleInput = {
      projectId,
      projectStatus: project.status,
      hasDirectorRevision: directorSummary?.hasRevision || false,
      hasApprovedDirector: directorSummary?.readyForVideo || false,
      hasReadyVideo: Boolean(currentRenderTarget),
      videoJobStates: jobSummaries.filter((item) => item.type === 'VIDEO_RENDER').map((item) => item.state),
      approvalStatus,
      publisherStatusCounts: publisherSummary.statusCounts,
      needsHumanActionCount: publisherSummary.needsHumanActionCount,
      hasExternalPost: publisherSummary.confirmedExternalPostCount > 0,
      jobs: jobSummaries.map((item) => ({ type: item.type, state: item.state })),
      jobStateCounts: jobStateSummary.stateCounts,
      videoJobStateCounts: jobStateSummary.videoStateCounts,
      approvalStatuses,
    };
    const health = deriveHealth(ruleInput);
    const stages = deriveStages(ruleInput);
    const failedSources = Array.from(new Set([
      director.failed ? 'Director' : null,
      assets.failed ? 'Video' : null,
      currentRender.failed ? 'Video' : null,
      jobs.failed || jobStates.failed ? 'Job' : null,
      failedJobs.failed ? 'Job' : null,
      approvals.failed ? 'Approval' : null,
      publisher.failed ? 'Publisher' : null,
      publisherRequests.failed ? 'Publisher' : null,
    ].filter((value): value is string => value !== null)));
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
    const currentStage = deriveCurrentStage(stages);
    return {
      project: safeProject(project),
      health,
      stages,
      currentStage,
      currentStageSummary: currentStage ? stages.find((stage) => stage.key === currentStage)?.summary || null : null,
      actions: buildActions(projectId, health, approvalStatus, publisherSummary, jobSummaries, failedSources, jobStateSummary.stateCounts, failedJobs.value || [], approvalStatuses, currentApprovalTargetStatuses),
      recentJobs: jobSummaries.map((job) => ({ id: job.id, type: job.type, state: job.state, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts, createdAt: job.createdAt })),
    };
  }
}
