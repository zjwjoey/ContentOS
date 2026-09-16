import { StatusBadge } from '../../app/_components/status-badge';

export function LocalMediaScanStatus({ status, discovered, analyzed, available }: { status: string; discovered: number; analyzed: number; available: number }) {
  return <p className="status">扫描状态：<StatusBadge status={status} /> · 已发现 {discovered} 个 · 已分析 {analyzed} 个 · 可用 {available} 个</p>;
}
