'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

type Step = { stage: string; status: string; attempt: number; errorMessage: string | null; outputRefs: Record<string, string | string[]> };
type Run = { id: string; title: string; status: string; currentStage: string; steps: Step[]; trace: Record<string, string | string[] | null> };
const labels: Record<string, string> = { CONTENT: '内容', VOICE: '配音', DIGITAL_HUMAN: '数字人', MATERIALS: '素材', EDITING: '剪辑', PREVIEW: '预览', APPROVAL: '审批', RENDER: '渲染', PUBLISH: '发布', REVIEW: '复盘' };

export default function ProductionRunDetailPage() {
  const params = useParams<{ id: string; runId: string }>(); const [run, setRun] = useState<Run | null>(null); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => { const response = await fetch(`/api/v1/projects/${params.id}/production-runs/${params.runId}`); if (response.ok) setRun(await response.json() as Run); }, [params.id, params.runId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const action = async (path: string, body?: unknown) => { setBusy(true); setMessage(''); try { const response = await fetch(`/api/v1/projects/${params.id}/production-runs/${params.runId}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); if (!response.ok) throw new Error('操作失败，请查看运行状态'); setRun(await response.json() as Run); } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); } finally { setBusy(false); } };
  if (!run) return <main className="shell"><section className="card">正在读取生产运行…</section></main>;
  return <main className="shell"><header><p className="eyebrow">Production Run / {run.id}</p><h1>{run.title}</h1><p className="muted">状态：{run.status} · 当前阶段：{labels[run.currentStage] || run.currentStage}</p><nav className="module-nav"><Link href={`/projects/${params.id}/production`}>返回运行列表</Link><button type="button" disabled={busy || run.status === 'CANCELLED'} onClick={() => void action('reconcile')}>对账状态</button><button type="button" disabled={busy || ['COMPLETED', 'COMPLETED_WITHOUT_PUBLISH', 'CANCELLED'].includes(run.status)} onClick={() => void action('cancel')}>取消运行</button></nav></header>{message && <section className="card form-error">{message}</section>}<section className="card"><div className="section-title"><h2>阶段进度</h2><span>{run.steps.filter((step) => ['SUCCEEDED', 'SKIPPED'].includes(step.status)).length}/{run.steps.length}</span></div><ol className="revision-list">{run.steps.map((step) => <li key={step.stage}><strong>{labels[step.stage] || step.stage}</strong><span>{step.status} · 尝试 {step.attempt}</span>{step.errorMessage && <small className="form-error">{step.errorMessage}</small>}{step.status === 'FAILED' && <button type="button" disabled={busy} onClick={() => void action('retry', { stage: step.stage })}>重试此阶段</button>}{step.status === 'PENDING' && <button type="button" disabled={busy} onClick={() => void action(`steps/${step.stage}`, { status: 'RUNNING' })}>开始阶段</button>}</li>)}</ol></section></main>;
}
