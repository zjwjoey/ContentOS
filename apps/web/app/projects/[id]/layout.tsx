'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ProjectNav } from './project-nav';
import { PRODUCT_STAGES, type ProductStageKey } from './product-model';
import { StatusBadge } from '../../_components/status-badge';

type Project = { id: string; name: string; status?: string };
export default function ProjectLayout({ children, params }: { children: ReactNode; params: { id: string } }) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pathname = usePathname();
  useEffect(() => { let active = true; setLoading(true); setError(''); void fetch(`/api/v1/projects/${params.id}`).then(async (response) => { if (!response.ok) throw new Error(response.status === 404 ? '项目不存在。' : '项目上下文读取失败。'); return response.json() as Promise<Project>; }).then((value) => { if (active) setProject(value); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : '项目上下文读取失败。'); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [params.id]);
  const currentStage: ProductStageKey | null = PRODUCT_STAGES.find((stage) => stage.href(params.id) === pathname)?.key || null;
  if (loading) return <div className="project-workspace"><header className="workspace-header"><Link className="muted" href="/">← 返回项目中心</Link><h2>正在读取项目…</h2></header><div className="project-workspace-content"><section className="card feedback">正在读取项目上下文…</section></div></div>;
  if (error || !project) return <div className="project-workspace"><header className="workspace-header"><Link className="muted" href="/">← 返回项目中心</Link><h2>项目不可用</h2></header><div className="project-workspace-content"><section className="card"><p className="form-error">{error || '项目上下文不可用。'}</p><Link className="module-nav-link" href="/">返回项目中心</Link></section></div></div>;
  return <div className="project-workspace"><header className="workspace-header"><div><Link className="muted" href="/">← 返回项目中心</Link><h2>{project.name}</h2></div>{project.status && <StatusBadge status={project.status} />}</header><ProjectNav projectId={params.id} currentStage={currentStage} /><div className="project-workspace-content">{children}</div></div>;
}
