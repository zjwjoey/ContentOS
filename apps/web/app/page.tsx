'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Project = { id: string; name: string; status: string };
type ApiError = { error?: { message?: string } };

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as ApiError;
    return data.error?.message || fallback;
  } catch { return fallback; }
}

export default function HomePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectName, setProjectName] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/v1/projects');
      if (!response.ok) throw new Error(await responseMessage(response, '项目列表加载失败。'));
      const data = await response.json() as { items: Project[] };
      setProjects(data.items);
      setMessage('');
    } catch (error) { setMessage(error instanceof Error ? error.message : '项目列表加载失败。'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const createProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreating(true); setMessage('');
    try {
      const response = await fetch('/api/v1/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: projectName.trim(), metadata: { createdBy: 'operator' } }) });
      if (!response.ok) throw new Error(await responseMessage(response, '项目创建失败。'));
      const project = await response.json() as Project;
      router.push(`/projects/${project.id}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '项目创建失败。'); }
    finally { setCreating(false); }
  };

  return <main className="shell">
    <header><p className="eyebrow">ContentOS / Operator</p><h1>内容项目</h1><p className="muted">从项目总控查看 Director、Video、Approval 和 Publisher 的整体进度。</p><nav className="module-nav"><Link href="/video/quick-edit">快速剪辑</Link></nav></header>
    <section className="card">
      <div className="section-title"><h2>创建项目</h2><span>Operator</span></div>
      <form className="project-create" onSubmit={createProject}>
        <label>项目名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="例如：门店经营知识矩阵" required maxLength={200} /></label>
        <button type="submit" disabled={creating}>{creating ? '创建中…' : '创建并进入项目总控'}</button>
      </form>
    </section>
    <section className="card">
      <div className="section-title"><h2>项目列表</h2><span>{loading ? '加载中…' : `${projects.length} 个项目`}</span></div>
      {message && <p className="form-error">{message}</p>}
      {loading ? <p className="muted">正在读取项目…</p> : projects.length === 0 ? <p className="muted">暂无项目，请先创建一个项目。</p> : <ul className="project-list">{projects.map((project) => <li key={project.id}><Link href={`/projects/${project.id}`}><span>{project.name || project.id}</span><small>{project.status}</small></Link></li>)}</ul>}
    </section>
  </main>;
}
