'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type EvaluationSet = { id: string; name: string; version: number; status: string; itemCount: number; queryCount: number; createdAt: string };

export default function ScriptEditingEvaluationPage() {
  const [workspaceId] = useState(() => typeof window === 'undefined' ? 'workspace-v3' : window.localStorage.getItem('contentos-v3-workspace') || 'workspace-v3');
  const [items, setItems] = useState<EvaluationSet[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void fetch(`/api/v1/edit/v3/evaluation-sets?workspaceId=${encodeURIComponent(workspaceId)}`).then((response) => response.ok ? response.json() as Promise<{ items: EvaluationSet[] }> : { items: [] }).then((data) => setItems(data.items)); }, [workspaceId]);
  const importFile = async (file: File | undefined) => { if (!file) return; setBusy(true); try { const payload = JSON.parse(await file.text()) as Record<string, unknown>; const response = await fetch('/api/v1/edit/v3/evaluation-sets/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, workspaceId, name: typeof payload.name === 'string' ? payload.name : file.name.replace(/\.json$/iu, '') }) }); const data = await response.json() as { error?: { code?: string } }; if (!response.ok) throw new Error(data.error?.code || 'Gold Set 导入失败'); setMessage('Gold Set 已导入并写入数据库真值。'); const list = await fetch(`/api/v1/edit/v3/evaluation-sets?workspaceId=${encodeURIComponent(workspaceId)}`).then((item) => item.json() as Promise<{ items: EvaluationSet[] }>); setItems(list.items); } catch (error) { setMessage(error instanceof Error ? error.message : 'Gold Set 导入失败'); } finally { setBusy(false); } };
  return <main className="shell"><header className="page-header"><p className="eyebrow">剪辑 / V3.4 Evaluation</p><div className="page-header-row"><div><h1>Gold Set Evaluation</h1><p className="muted">人工标注的 Visual Need、可用素材和禁用素材写入数据库；没有配置 AI 时不会伪造 semantic 结果。</p></div><Link className="module-nav-link" href="/edit/script/v3">返回 V3 Workbench</Link></div></header><section className="card"><h2>导入 Gold Set</h2><p className="muted">要求 100–300 条素材、10–20 条 Visual Need。导入后可由 benchmark 读取同一数据库事实。</p><label className="inline-field">选择 JSON<input type="file" accept="application/json" disabled={busy} onChange={(event) => void importFile(event.target.files?.[0])} /></label>{message && <p className="status">{message}</p>}</section><section className="card"><div className="section-title"><h2>Evaluation Sets</h2><span>{items.length} 个</span></div>{items.length === 0 ? <p className="muted">暂无 Gold Set。</p> : <ul className="revision-list">{items.map((item) => <li key={item.id}><strong>{item.name} v{item.version}</strong><span>{item.status} · {item.itemCount} assets · {item.queryCount} visual needs</span><Link href={`/edit/script/v3/evaluation/${encodeURIComponent(item.id)}`}>查看</Link></li>)}</ul>}</section></main>;
}
