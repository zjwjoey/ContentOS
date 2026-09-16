import Link from 'next/link';
import { PRODUCT_STAGES, type ProductStageKey } from './product-model';

export function ProjectNav({ projectId, currentStage }: { projectId: string; currentStage?: ProductStageKey | null }) {
  const labels: Record<string, string> = { ASSETS: '素材', DIRECTOR: '脚本与分镜', BENCHMARK: '基准测试', VIDEO: '视频剪辑', APPROVALS: '审批', PUBLISHER: '发布', REVIEW: '复盘分析' };
  // Keep the protocol names in code (Overview / Assets / Director / Benchmark / Video / Approval / Publisher) while presenting Chinese labels to operators.
  return <nav className="project-stage-rail" aria-label="项目阶段"><Link className={!currentStage ? 'project-stage-overview active' : 'project-stage-overview'} href={`/projects/${projectId}`}>项目总览</Link>{PRODUCT_STAGES.map((stage) => <Link key={stage.key} className={stage.key === currentStage ? 'project-stage-link active' : 'project-stage-link'} href={stage.href(projectId)}><span>{labels[stage.key] || stage.label}</span><small>{stage.key === currentStage ? '当前阶段' : '进入'}</small></Link>)}</nav>;
}
