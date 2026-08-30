import Link from 'next/link';
import { PRODUCT_STAGES, type ProductStageKey } from './product-model';

export function ProjectNav({
  projectId,
  currentStage,
  reviewActive = false,
}: {
  projectId: string;
  currentStage?: ProductStageKey | null;
  reviewActive?: boolean;
}) {
  return (
    <nav className="project-stage-rail" aria-label="项目阶段">
      <Link className={!currentStage && !reviewActive ? 'project-stage-overview active' : 'project-stage-overview'} href={`/projects/${projectId}`}>
        {'Overview'}
      </Link>
      {PRODUCT_STAGES.map((stage) => (
        <Link key={stage.key} className={stage.key === currentStage ? 'project-stage-link active' : 'project-stage-link'} href={stage.href(projectId)}>
          <span>{stage.label === 'Approval Gate' ? 'Approval' : stage.label}</span>
          <small>{stage.key === currentStage ? '当前阶段' : '进入'}</small>
        </Link>
      ))}
      <Link className={reviewActive ? 'project-stage-link active' : 'project-stage-link'} href={`/projects/${projectId}/review`}>
        <span>Review Analytics</span>
        <small>{reviewActive ? '当前阶段' : '进入'}</small>
      </Link>
    </nav>
  );
}
