'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
type Project = { id: string; name: string; status: string };

export default function HomePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => { void fetch('/api/v1/projects').then((response) => response.json() as Promise<{ items: Project[] }>).then((data) => setProjects(data.items)); }, []);
  return <main className="shell"><header><p className="eyebrow">ContentOS / Operator</p><h1>内容项目</h1><p className="muted">从项目进入 Director，追踪 Brief、Job、Script 和 Storyboard 的版本状态。</p></header><section className="card"><div className="section-title"><h2>项目列表</h2><span>{projects.length} 个项目</span></div>{projects.length === 0 ? <p className="muted">暂无项目，请先通过 API 创建项目。</p> : <ul className="project-list">{projects.map((project) => <li key={project.id}><Link href={`/projects/${project.id}/director`}><span>{project.name || project.id}</span><small>{project.status}</small></Link></li>)}</ul>}</section></main>;
}
