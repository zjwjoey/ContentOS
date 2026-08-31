'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Project = { id: string; name: string; status: string; metadata?: { topic?: string; targetPlatform?: string; targetAccount?: string; plannedDate?: string } };
type ApiError = { error?: { message?: string } };
type Dashboard = { counts: { total: number; active: number; attention: number; blocked: number; complete: number; pendingActions: number; runningJobs: number } };

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
  const [topic, setTopic] = useState(''); const [platform, setPlatform] = useState('douyin'); const [account, setAccount] = useState(''); const [plannedDate, setPlannedDate] = useState('');
  const [query, setQuery] = useState(''); const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams(); if (query.trim()) params.set('q', query.trim()); if (statusFilter) params.set('status', statusFilter); const [response, dashboardResponse] = await Promise.all([fetch(`/api/v1/projects?${params}`), fetch('/api/v1/dashboard')]);
      if (!response.ok) throw new Error(await responseMessage(response, '项目列表加载失败。'));
      const data = await response.json() as { items: Project[] };
      setProjects(data.items);
      if (dashboardResponse.ok) setDashboard(await dashboardResponse.json() as Dashboard);
      setMessage('');
    } catch (error) { setMessage(error instanceof Error ? error.message : '项目列表加载失败。'); }
    finally { setLoading(false); }
  }, [query, statusFilter]);

  useEffect(() => { void refresh(); }, [refresh]);

  const createProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreating(true); setMessage('');
    try {
      const response = await fetch('/api/v1/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: projectName.trim(), metadata: { createdBy: 'operator', topic: topic.trim(), targetPlatform: platform, ...(account.trim() ? { targetAccount: account.trim() } : {}), ...(plannedDate ? { plannedDate } : {}) } }) });
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
        <label>项目名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="例如：门店经营知识矩阵" required maxLength={200} /></label><label>选题<input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="计划选题" /></label><label>平台<select value={platform} onChange={(event) => setPlatform(event.target.value)}><option value="douyin">抖音</option><option value="wechat_channels">视频号</option></select></label><label>目标账号<input value={account} onChange={(event) => setAccount(event.target.value)} placeholder="账号名称" /></label><label>计划日期<input type="date" value={plannedDate} onChange={(event) => setPlannedDate(event.target.value)} /></label>
        <button type="submit" disabled={creating}>{creating ? '创建中…' : '创建并进入项目总控'}</button>
      </form>
    </section>
    {dashboard && <section className="card" data-testid="dashboard-summary"><div className="section-title"><h2>运营总览</h2><span>实时汇总</span></div><div className="grid"><p><strong>{dashboard.counts.active}</strong><br /><small>活跃项目</small></p><p><strong>{dashboard.counts.attention}</strong><br /><small>需要关注</small></p><p><strong>{dashboard.counts.blocked}</strong><br /><small>存在阻塞</small></p><p><strong>{dashboard.counts.pendingActions}</strong><br /><small>待处理事项</small></p><p><strong>{dashboard.counts.runningJobs}</strong><br /><small>运行中 Job</small></p><p><strong>{dashboard.counts.complete}</strong><br /><small>已完成项目</small></p></div></section>}
    <section className="card">
      <div className="section-title"><h2>项目列表</h2><span>{loading ? '加载中…' : `${projects.length} 个项目`}</span></div><div className="grid"><label>搜索项目 / 选题<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词" /></label><label>状态<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">全部状态</option><option>DRAFT</option><option>IN_PRODUCTION</option><option>READY_TO_PUBLISH</option><option>PUBLISHED</option><option>ARCHIVED</option></select></label></div>
      {message && <p className="form-error">{message}</p>}
      {loading ? <p className="muted">正在读取项目…</p> : projects.length === 0 ? <p className="muted">暂无项目，请先创建一个项目。</p> : <ul className="project-list">{projects.map((project) => <li key={project.id}><Link href={`/projects/${project.id}`}><span><strong>{project.name || project.id}</strong><small>{project.metadata?.topic || '未填写选题'} · {project.metadata?.targetPlatform || '未指定平台'} · {project.metadata?.plannedDate || '未排期'}</small></span><small>{project.status}</small></Link></li>)}</ul>}
    </section>
  </main>;
}
