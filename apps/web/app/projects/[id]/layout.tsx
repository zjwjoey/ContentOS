'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ProjectNav } from './project-nav';
import { StatusBadge } from '../../_components/status-badge';

type Project = { id: string; name: string; status?: string };
export default function ProjectLayout({ children, params }: { children: ReactNode; params: { id: string } }) {
  const [project, setProject] = useState<Project | null>(null);
  const pathname = usePathname();
  useEffect(() => { let active = true; void fetch(`/api/v1/projects/${params.id}`).then((response) => response.ok ? response.json() as Promise<Project> : null).then((value) => { if (active) setProject(value); }).catch(() => undefined); return () => { active = false; }; }, [params.id]);
  const showOverviewNav = pathname === `/projects/${params.id}`;
  return <div className="project-workspace"><header className="workspace-header"><div><Link className="muted" href="/">← 返回项目中心</Link><h2>{project?.name || `项目 ${params.id}`}</h2></div>{project?.status && <StatusBadge status={project.status} />}</header>{showOverviewNav && <ProjectNav projectId={params.id} />}<div className="project-workspace-content">{children}</div></div>;
}
