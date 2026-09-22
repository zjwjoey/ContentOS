/** User-facing labels for backend enum values. Keep protocol values unchanged. */
const productionStages: Record<string, string> = {
  CONTENT: '内容', VOICE: '配音', DIGITAL_HUMAN: '数字人', MATERIALS: '素材',
  EDITING: '剪辑', PREVIEW: '预览', APPROVAL: '审批', RENDER: '渲染', PUBLISH: '发布', REVIEW: '复盘',
};

const runStatuses: Record<string, string> = {
  DRAFT: '草稿', RUNNING: '进行中', WAITING_USER: '等待操作', FAILED: '失败', CANCELLED: '已取消',
  COMPLETED: '已完成', COMPLETED_WITHOUT_PUBLISH: '已完成（未发布）',
};

const stepStatuses: Record<string, string> = {
  PENDING: '待开始', RUNNING: '进行中', WAITING_USER: '等待操作', SUCCEEDED: '已完成',
  SKIPPED: '已跳过', FAILED: '失败', CANCELLED: '已取消',
};

const digitalHumanModes: Record<string, string> = {
  NONE: '不使用数字人', INTRO_ONLY: '仅片头数字人', OUTRO_ONLY: '仅片尾数字人',
  FULL_TALKING_HEAD: '全程数字人口播', CUSTOM: '自定义',
};

const jobStates: Record<string, string> = {
  QUEUED: '排队中', RUNNING: '进行中', SUCCEEDED: '已完成', FAILED: '失败',
  CANCELLED: '已取消', RETRY_WAIT: '等待重试', PENDING: '待开始',
};

export function productionStageLabel(value?: string | null): string { return value ? productionStages[value] || value : '未开始'; }
export function productionRunStatusLabel(value?: string | null): string { return value ? runStatuses[value] || value : '未知状态'; }
export function productionStepStatusLabel(value?: string | null): string { return value ? stepStatuses[value] || value : '未知状态'; }
export function digitalHumanModeLabel(value?: string | null): string { return value ? digitalHumanModes[value] || value : '未设置'; }
export function jobStateLabel(value?: string | null): string { return value ? jobStates[value] || value : '未知状态'; }
export function standardProductionTemplateLabel(value?: string | null): string { return value === 'STANDARD_SHORT_VIDEO' ? '标准短视频流程' : value || '未设置'; }
