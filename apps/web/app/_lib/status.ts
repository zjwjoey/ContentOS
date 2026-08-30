export type UiStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export type UiStatusGroup = 'idle' | 'active' | 'ready' | 'attention' | 'error';
export type UiStatusView = { label: string; tone: UiStatusTone; group: UiStatusGroup; raw: string };

const MAP: Record<string, Omit<UiStatusView, 'raw'>> = {
  NOT_STARTED: { label: '未开始', tone: 'neutral', group: 'idle' }, QUEUED: { label: '排队中', tone: 'info', group: 'active' }, RUNNING: { label: '处理中', tone: 'info', group: 'active' },
  RETRY_WAIT: { label: '等待重试', tone: 'warning', group: 'attention' }, READY: { label: '已就绪', tone: 'success', group: 'ready' }, PENDING: { label: '待确认', tone: 'warning', group: 'attention' },
  APPROVED: { label: '已批准', tone: 'success', group: 'ready' }, SUCCEEDED: { label: '已完成', tone: 'success', group: 'ready' }, FAILED: { label: '失败', tone: 'danger', group: 'error' },
  REJECTED: { label: '已驳回', tone: 'danger', group: 'error' }, RECONCILING: { label: '状态确认中', tone: 'warning', group: 'attention' },
};
export function getStatusView(status: string | null | undefined): UiStatusView { const raw = status || 'NOT_STARTED'; return { ...(MAP[raw] || { label: raw, tone: 'neutral', group: 'idle' }), raw }; }
