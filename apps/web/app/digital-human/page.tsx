'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

type Project = { id: string; name: string; status: string; metadata?: { topic?: string; targetPlatform?: string } };

export default function DigitalHumanIndexPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/v1/projects');
      if (!response.ok) throw new Error('项目列表加载失败。');
      setProjects((await response.json() as { items: Project[] }).items);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '项目列表加载失败。');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  return <main className="shell"><header className="page-header"><p className="eyebrow">ContentOS / 数字人</p><h1>数字人工作台</h1><p className="muted">请选择一个项目，管理音色、人物底片、配音和数字人成片。</p></header>
    {message && <section className="card form-error" role="alert">{message}<button type="button" onClick={() => void refresh()}>重试</button></section>}
    <section className="card"><div className="section-title"><h2>选择项目</h2><span>{loading ? '加载中…' : `${projects.length} 个项目`}</span></div>
      {loading ? <p className="muted">正在加载项目…</p> : projects.length === 0 ? <p className="muted">暂无项目，请先返回首页创建项目。</p> : <ul className="project-list">{projects.map((project) => <li key={project.id}><Link href={`/projects/${project.id}/avatar`}><span><strong>{project.name || project.id}</strong><small>{project.metadata?.topic || '未填写选题'} · {project.metadata?.targetPlatform || '未指定平台'}</small></span><small>打开数字人</small></Link></li>)}</ul>}
    </section>
  </main>;
}
