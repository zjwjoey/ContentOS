'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { digitalHumanModeLabel, productionRunStatusLabel, productionStageLabel, standardProductionTemplateLabel } from '../../../_lib/display-labels';

type Run = { id: string; title: string; status: string; currentStage: string; digitalHumanMode: string; approvalRequired: boolean; createdAt: string; updatedAt: string };

export default function ProductionRunsPage() {
  const params = useParams<{ id: string }>(); const projectId = params.id;
  const [runs, setRuns] = useState<Run[]>([]); const [title, setTitle] = useState(''); const [mode, setMode] = useState('NONE'); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const refresh = useCallback(async () => { const response = await fetch(`/api/v1/projects/${projectId}/production-runs`); if (response.ok) setRuns((await response.json() as { items: Run[] }).items); }, [projectId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const create = async () => { if (!title.trim()) return; setBusy(true); setMessage(''); try { const response = await fetch(`/api/v1/projects/${projectId}/production-runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.trim(), digitalHumanMode: mode, approvalRequired: true, idempotencyKey: `operator-${projectId}-${title.trim()}` }) }); if (!response.ok) throw new Error('生产任务创建失败'); setTitle(''); setMessage('生产任务已创建，可进入详情推进各阶段。'); await refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : '生产任务创建失败'); } finally { setBusy(false); } };
  return <main className="shell"><header><p className="eyebrow">项目 / {projectId}</p><h1>内容生产编排</h1><p className="muted">统一串联内容、配音、数字人、素材、剪辑、预览、审批、渲染、发布与复盘；每一步都保留可恢复状态。</p><nav className="module-nav"><Link href={`/projects/${projectId}`}>项目总控</Link><Link href={`/projects/${projectId}/director`}>内容策划</Link><Link href={`/projects/${projectId}/video`}>视频剪辑</Link><Link href={`/projects/${projectId}/avatar`}>数字人</Link></nav></header>
    <section className="card"><div className="section-title"><h2>新建生产任务</h2><span>{standardProductionTemplateLabel('STANDARD_SHORT_VIDEO')}</span></div><label>任务名称<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：9 月新品短视频" /></label><label>数字人模式<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="NONE">{digitalHumanModeLabel('NONE')}</option><option value="INTRO_ONLY">{digitalHumanModeLabel('INTRO_ONLY')}</option><option value="OUTRO_ONLY">{digitalHumanModeLabel('OUTRO_ONLY')}</option><option value="FULL_TALKING_HEAD">{digitalHumanModeLabel('FULL_TALKING_HEAD')}</option><option value="CUSTOM">{digitalHumanModeLabel('CUSTOM')}</option></select></label><button type="button" disabled={busy || !title.trim()} onClick={() => void create()}>{busy ? '创建中…' : '创建生产任务'}</button>{message && <p className="status">{message}</p>}</section>
    <section className="card"><div className="section-title"><h2>生产任务列表</h2><span>{runs.length} 条</span></div>{runs.length ? <ul className="revision-list">{runs.map((run) => <li key={run.id}><strong>{run.title}</strong><span>{productionRunStatusLabel(run.status)} · 当前阶段：{productionStageLabel(run.currentStage)} · {digitalHumanModeLabel(run.digitalHumanMode)}</span><small>更新于 {new Date(run.updatedAt).toLocaleString('zh-CN')}</small><Link className="module-nav-link" href={`/projects/${projectId}/production/${run.id}`}>打开任务详情</Link></li>)}</ul> : <p className="muted">暂无生产任务。</p>}</section>
  </main>;
}
