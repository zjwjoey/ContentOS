import { getStatusView } from '../_lib/status';
export function StatusBadge({ status }: { status: string | null | undefined }) { const view = getStatusView(status); return <span className={`status-badge tone-${view.tone}`} data-status={view.raw} title={view.raw}>{view.label}</span>; }
