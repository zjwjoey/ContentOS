import Link from 'next/link';
import { PRODUCT_STAGES, type ProductStageKey } from './product-model';

export function ProjectNav({ projectId, currentStage }: { projectId: string; currentStage?: ProductStageKey | null }) {
  return <nav className="project-stage-rail" aria-label="项目阶段"><Link className={!currentStage ? 'project-stage-overview active' : 'project-stage-overview'} href={`/projects/${projectId}`}>总览</Link>{PRODUCT_STAGES.map((stage) => <Link key={stage.key} className={stage.key === currentStage ? 'project-stage-link active' : 'project-stage-link'} href={stage.href(projectId)}><span>{stage.label}</span><small>{stage.key === currentStage ? '当前阶段' : '进入'}</small></Link>)}</nav>;
}
