'use client';

import { use, useCallback, useEffect, useState } from 'react';

type Snapshot = { id: string; capturedAt: string; metrics: { plays: number; likes: number; comments: number; saves: number; shares: number }; source: string };
type Report = { id: string; summary: string; highlights: Array<{ title: string; detail: string }>; risks: Array<{ title: string; detail: string }>; recommendations: Array<{ priority: string; title: string; detail: string }> };
type Item = { post: { id: string; platformId: string; externalPostId: string; externalUrl: string | null }; snapshots: Snapshot[]; reports: Report[] };

export default function ReviewAnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const projectId = use(params).id;
  const [items, setItems] = useState<Item[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/v1/projects/${projectId}/reviews/analytics`);
    if (response.ok) setItems(((await response.json()) as { items: Item[] }).items);
  }, [projectId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const collect = async (postId: string) => {
    setBusy(true); setMessage('正在排队采集指标…');
    const response = await fetch(`/api/v1/projects/${projectId}/reviews/analytics/posts/${postId}/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'FAKE', idempotencyKey: `review-collect-${projectId}-${postId}`, correlationId: `review-${projectId}` }) });
    setMessage(response.ok ? '指标采集 Job 已排队。' : '指标采集排队失败。');
    if (response.ok) window.setTimeout(() => void refresh(), 350);
    setBusy(false);
  };
  const analyze = async (item: Item) => {
    if (!item.snapshots.length) return;
    setBusy(true); setMessage('正在排队生成 AI 复盘…');
    const response = await fetch(`/api/v1/projects/${projectId}/reviews/analytics/posts/${item.post.id}/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ metricSnapshotIds: item.snapshots.map((snapshot) => snapshot.id), idempotencyKey: `review-analyze-${projectId}-${item.post.id}-${item.snapshots.map((snapshot) => snapshot.id).join('-')}`, correlationId: `review-${projectId}` }) });
    setMessage(response.ok ? 'AI 复盘 Job 已排队。' : 'AI 复盘排队失败。');
    setBusy(false);
  };

  return <main className="shell"><header><p className="eyebrow">Project / {projectId}</p><h1>Review Analytics</h1><p className="muted">这里只处理已确认发布内容的 Fake/Import 指标快照与 AI 复盘，不改变 Approval Gate 或发布状态。</p></header>{message && <p className="feedback">{message}</p>}{items.length === 0 ? <section className="card"><h2>暂无已确认外部内容</h2><p className="muted">请先在 Publisher 完成 Fake Platform 发布闭环。</p></section> : <div>{items.map((item) => { const latest = item.snapshots[0]; const report = item.reports[0]; return <section className="card" key={item.post.id} data-testid="review-post"><div className="section-title"><h2>{item.post.platformId} · {item.post.externalPostId}</h2><span>{item.snapshots.length} 个快照</span></div>{latest ? <><p>播放 {latest.metrics.plays} · 点赞 {latest.metrics.likes} · 评论 {latest.metrics.comments} · 收藏 {latest.metrics.saves} · 分享 {latest.metrics.shares}</p><small className="muted">采集于 {new Date(latest.capturedAt).toLocaleString()} · {latest.source}</small></> : <p className="muted">尚未采集指标。</p>}<div className="module-nav"><button data-testid="collect-metrics" disabled={busy} onClick={() => void collect(item.post.id)}>采集指标</button><button data-testid="analyze-review" disabled={busy || !item.snapshots.length} onClick={() => void analyze(item)}>生成 AI 复盘</button></div>{report && <div className="card"><h3>最新复盘</h3><p>{report.summary}</p>{report.recommendations.map((recommendation) => <p key={recommendation.title}><strong>{recommendation.priority} · {recommendation.title}</strong>：{recommendation.detail}</p>)}</div>}</section>; })}</div>}</main>;
}

