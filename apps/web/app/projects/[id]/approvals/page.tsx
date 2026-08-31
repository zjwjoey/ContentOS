'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

type Decision = { id: string; targetType: 'SCRIPT' | 'STORYBOARD' | 'RENDER' | 'PUBLISH'; targetId: string; targetRevisionId: string; revision: number; status: 'PENDING' | 'APPROVED' | 'REJECTED'; approver: string; reason?: string; targetLabel: string; createdAt: string };
type ApiError = { error?: { message?: string } };
async function responseMessage(response: Response, fallback: string): Promise<string> { try { const data = await response.json() as ApiError; return data.error?.message || fallback; } catch { return fallback; } }

export default function ApprovalsPage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const [items, setItems] = useState<Decision[]>([]);
  const [message, setMessage] = useState('');
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/v1/projects/${projectId}/approvals`);
    if (!response.ok) { setMessage(await responseMessage(response, 'Approval Gate 读取失败。')); return; }
    setItems((await response.json() as { items: Decision[] }).items);
  }, [projectId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const transition = async (decision: Decision, action: 'approve' | 'reject') => {
    const response = await fetch(`/api/v1/projects/${projectId}/approvals/${decision.targetType}/${decision.targetId}/${decision.targetRevisionId}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approver: 'operator', ...(action === 'reject' && reason.trim() ? { reason: reason.trim() } : {}) }) });
    setMessage(response.ok ? `${decision.targetLabel} 已${action === 'approve' ? '批准' : '驳回'}。` : await responseMessage(response, 'Approval 状态更新失败。')); setRejecting(null); setReason(''); await refresh();
  };
  const scripts = items.filter((item) => item.targetType === 'SCRIPT'); const storyboards = items.filter((item) => item.targetType === 'STORYBOARD');
  const renders = items.filter((item) => item.targetType === 'RENDER');
  const publishes = items.filter((item) => item.targetType === 'PUBLISH');
  const section = (title: string, decisions: Decision[]) => <section className="card"><div className="section-title"><h2>{title}</h2><span>{decisions.length} 条</span></div>{decisions.length === 0 ? <p className="muted">暂无待处理 Revision。</p> : <ul className="revision-list">{decisions.map((decision) => <li key={decision.id}><strong>{decision.targetLabel}</strong><span>目标 Revision：{decision.targetRevisionId} · 当前状态：{decision.status}</span>{decision.reason && <small>理由：{decision.reason}</small>}{decision.status === 'PENDING' && <p><button type="button" onClick={() => void transition(decision, 'approve')}>批准此 Revision</button>{' '}<button type="button" onClick={() => { setRejecting(decision.id); setReason(''); }}>驳回</button>{rejecting === decision.id && <span><label>拒绝原因<textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label><button type="button" onClick={() => reason.trim() ? void transition(decision, 'reject') : setMessage('驳回必须填写理由。')}>确认驳回</button></span>}</p>}</li>)}</ul>}</section>;
  return <main className="shell"><header><p className="eyebrow">Project / {projectId}</p><h1>Approval Gate</h1><p className="muted">所有决定都绑定具体 targetId 与 targetRevisionId；批准后只追加新决定，不覆盖历史。</p><nav className="module-nav"><Link href={`/projects/${projectId}/director`}>Director</Link><Link href={`/projects/${projectId}/video`}>Video</Link><Link href={`/projects/${projectId}/publisher`}>Publisher</Link></nav></header>{section('Script Approval Gate', scripts)}{section('Storyboard Approval Gate', storyboards)}{section('成片 Approval Gate', renders)}{section('发布 Revision Approval Gate', publishes)}{message && <p className="status">{message}</p>}</main>;
}
