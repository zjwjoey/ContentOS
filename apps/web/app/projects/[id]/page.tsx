'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

type Stage = {
  key: 'DIRECTOR' | 'VIDEO' | 'APPROVAL' | 'PUBLISHER';
  status: string;
  label: string;
  href: string | null;
  summary: string;
};
type Snapshot = {
  project: { id: string; name: string; status: string; updatedAt: string };
  health: { level: string; reasons: string[] };
  stages: Stage[];
  currentStage: string | null;
  currentStageSummary: string | null;
  actions: Array<{ id: string; kind: string; title: string; detail: string; severity: string; href: string | null }>;
  recentJobs: Array<{ id: string; type: string; state: string; attemptCount: number; maxAttempts: number; createdAt: string }>;
};
type ApiError = { error?: { code?: string; message?: string } };

function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    HEALTHY: '运行正常',
    ATTENTION: '需要关注',
    BLOCKED: '存在阻塞',
    COMPLETE: '已完成',
    NOT_STARTED: '未开始',
    IN_PROGRESS: '进行中',
    ACTION_REQUIRED: '待处理',
    READY: '已就绪',
    FAILED: '失败',
    SUCCEEDED: '成功',
    QUEUED: '排队中',
    RUNNING: '运行中',
    RETRY_WAIT: '等待重试',
  };
  return labels[value] || value;
}

function errorMessage(response: Response): Promise<string> {
  return response.json().then((data: ApiError) => data.error?.code === 'PROJECT_NOT_FOUND' ? '项目不存在。' : data.error?.message || '项目总控加载失败。').catch(() => '项目总控加载失败。');
}

export default function ProjectCenterPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setMessage('');
    setMissing(false);
    try {
      const response = await fetch('/api/v1/projects/' + projectId + '/center');
      if (!response.ok) {
        if (response.status === 404) setMissing(true);
        throw new Error(await errorMessage(response));
      }
      setSnapshot(await response.json() as Snapshot);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '项目总控加载失败。');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (loading) return <main className="shell"><section className="card project-center-loading">正在读取项目总控…</section></main>;
  if (missing) return <main className="shell"><section className="card"><h1>项目不存在</h1><p className="muted">{message}</p><Link className="module-nav-link" href="/">返回项目列表</Link></section></main>;
  if (!snapshot) return <main className="shell"><section className="card"><h1>项目总控暂时不可用</h1><p className="form-error">{message}</p><button type="button" onClick={() => void refresh()}>刷新</button></section></main>;

  return <main className="shell project-center" data-testid="project-center">
    <header className="project-center-header">
      <div><p className="eyebrow">ContentOS / Project Center</p><h1>{snapshot.project.name}</h1><p className="muted">{snapshot.project.status} · 更新于 {new Date(snapshot.project.updatedAt).toLocaleString('zh-CN')}</p></div>
      <button type="button" onClick={() => void refresh()}>刷新</button>
    </header>
    {message && snapshot && <section className="card form-error" role="alert">当前显示的是上一次成功读取的数据：{message} <button type="button" onClick={() => void refresh()}>重试</button></section>}
    <div className="project-center-layout">
      <section className="project-center-content">
        <section className="card current-stage-summary" data-testid="current-stage-summary"><p className="eyebrow">当前阶段</p><h2>{snapshot.currentStage || '未开始'}</h2><p className="muted">{snapshot.currentStageSummary || '暂无阶段摘要。'}</p></section>
        <section className="card health-card" data-testid="health-level" data-status={snapshot.health.level}>
          <div><p className="eyebrow">项目健康度</p><h2>{statusLabel(snapshot.health.level)}</h2></div>
          <div className="health-reasons">{snapshot.health.reasons.length ? snapshot.health.reasons.map((reason) => <span key={reason}>{reason}</span>) : <span>当前没有需要处理的风险。</span>}</div>
        </section>
        <section className="stage-card-grid">
          {snapshot.stages.map((stage) => <article className="card stage-card" data-testid={'stage-card-' + stage.key} data-status={stage.status} key={stage.key}><div className="stage-card-title"><span>{stage.label}</span><strong>{statusLabel(stage.status)}</strong></div><p className="muted">{stage.summary}</p>{stage.href && <Link className="module-nav-link" href={stage.href}>进入工作台</Link>}</article>)}
        </section>
        <section className="project-center-columns">
          <section className="card" data-testid="project-actions"><div className="section-title"><h2>待处理事项</h2><span>{snapshot.actions.length} 项</span></div>{snapshot.actions.length ? <ul className="action-list">{snapshot.actions.map((action) => <li key={action.id}><div><strong>{action.title}</strong><p className="muted">{action.detail}</p></div>{action.href && <Link className="module-nav-link" href={action.href}>查看</Link>}</li>)}</ul> : <p className="muted">暂无待处理事项。</p>}</section>
          <section className="card" data-testid="recent-jobs"><div className="section-title"><h2>最近 Job</h2><span>{snapshot.recentJobs.length} 条</span></div>{snapshot.recentJobs.length ? <ul className="job-list">{snapshot.recentJobs.map((job) => <li data-state={job.state} key={job.id}><span>{job.type}</span><small>{statusLabel(job.state)} · {job.attemptCount}/{job.maxAttempts}</small></li>)}</ul> : <p className="muted">暂无异步 Job。</p>}</section>
        </section>
      </section>
    </div>
  </main>;
}
