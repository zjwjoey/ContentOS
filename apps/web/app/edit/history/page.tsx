'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

type BatchItem = { id: string; ordinal: number; title: string; script: string; state: string; phase?: string; sourceStats?: { localCount: number; externalCount: number; fallbackCount: number }; outputPath?: string; error?: { message?: string }; exportId?: string; exportStatus?: string; exportError?: { message?: string } };
type Batch = { id: string; title: string; mode: string; testOnly?: boolean; status: string; totalCount: number; succeededCount: number; failedCount: number; exportedCount: number; exportQueuedCount: number; exportFailedCount: number; page: number; pageSize: number; outputRoot?: string | null; items: BatchItem[] };
type History = { id: string; title: string; mode: string; testOnly?: boolean; status: string; totalCount: number; succeededCount: number; failedCount: number; createdAt: string; outputRoot?: string | null };

function statusLabel(status: string, item?: { succeededCount: number; failedCount: number }): string { if (status === 'SUCCEEDED') return '已完成'; if (status === 'PARTIAL') return `${item?.succeededCount || 0} 成功 / ${item?.failedCount || 0} 失败`; if (status === 'FAILED') return '剪辑失败'; if (status === 'RUNNING') return '正在剪辑'; if (status === 'QUEUED') return '等待中'; return '处理中'; }
function itemStateLabel(state: string, error?: { message?: string }, exportStatus?: string, exportError?: { message?: string }, phase?: string): string { if (exportStatus === 'FAILED') return `导出失败：${exportError?.message || '请重试导出'}`; if (exportStatus === 'QUEUED' || exportStatus === 'RUNNING') return '正在导出'; if (state === 'SUCCEEDED') return '已完成'; if (state === 'FAILED') return `失败：${error?.message || '渲染失败'}`; if (phase === 'VISUAL_PLANNING') return '正在规划画面'; if (phase === 'MANIFEST_BUILDING') return '正在生成时间线'; if (state === 'PREPARING') return '正在准备素材'; if (state === 'RENDERING' || state === 'RUNNING') return '正在渲染'; return '排队中'; }

function EditHistoryContent() {
  const search = useSearchParams();
  const selectedId = search.get('batch');
  const [history, setHistory] = useState<History[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [detailPage, setDetailPage] = useState(Number(search.get('page') || 1));
  const [message, setMessage] = useState('');
  const [exportPending, setExportPending] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/edit/history');
      if (response.ok) setHistory((await response.json() as { items: History[] }).items);
      if (selectedId) {
        const detail = await fetch(`/api/v1/edit/batches/${encodeURIComponent(selectedId)}?page=${detailPage}&pageSize=50`);
        if (detail.ok) setBatch(await detail.json() as Batch);
      }
    } catch { setMessage('剪辑记录暂时无法读取。'); }
  }, [selectedId, detailPage]);
  useEffect(() => { setDetailPage(Number(search.get('page') || 1)); }, [search]);
  const batchActive = Boolean(batch && (batch.status === 'RUNNING' || batch.status === 'QUEUED' || batch.succeededCount + batch.failedCount < batch.totalCount || exportPending));
  useEffect(() => { void refresh(); if (!selectedId || !batchActive) return; const timer = window.setInterval(() => void refresh(), 2500); return () => window.clearInterval(timer); }, [refresh, selectedId, batchActive]);
  const retry = async () => { if (!batch) return; await fetch(`/api/v1/edit/batches/${batch.id}/retry`, { method: 'POST' }); await refresh(); };
  const retryExport = async (exportId: string) => { const response = await fetch(`/api/v1/edit/exports/${encodeURIComponent(exportId)}/retry`, { method: 'POST' }); if (!response.ok) { const data = await response.json() as { error?: { message?: string } }; setMessage(data.error?.message || '导出重试失败。'); return; } setMessage('已重新排队导出任务。'); await refresh(); };
  const exportFiles = async () => {
    if (!batch) return;
    setExportPending(true);
    try {
      const response = await fetch(`/api/v1/edit/batches/${batch.id}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
      const data = await response.json() as { error?: { message?: string }; files?: string[] };
      if (!response.ok) { setMessage(data.error?.message || '导出失败，请检查输出目录配置。'); return; }
      setMessage(`已创建 ${data.files?.length || 0} 个导出任务，正在等待落盘。`);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const detail = await fetch(`/api/v1/edit/batches/${encodeURIComponent(batch.id)}?page=${detailPage}&pageSize=50`);
        if (detail.ok) { const next = await detail.json() as Batch; setBatch(next); if (next.exportQueuedCount === 0 && next.exportedCount >= next.succeededCount) break; }
        await new Promise((resolveWait) => window.setTimeout(resolveWait, 500));
      }
    } finally { setExportPending(false); }
  };
  const copyOutputPath = async () => { if (!batch?.outputRoot) return; await navigator.clipboard.writeText(batch.outputRoot); setMessage('输出路径已复制。'); };
  return <main className="shell"><header className="page-header"><p className="eyebrow">剪辑 / 历史记录</p><div className="page-header-row"><div><h1>剪辑记录</h1><p className="muted">查看进度、失败任务和导出位置。</p></div><Link className="module-nav-link" href="/edit">新建剪辑</Link></div></header><div className="grid"><section className="card"><div className="section-title"><h2>最近任务</h2><span>{history.length} 条</span></div>{history.length === 0 ? <p className="muted">还没有记录。</p> : <ul className="project-list">{history.map((item) => <li key={item.id}><Link href={`/edit/history?batch=${encodeURIComponent(item.id)}`}><span><strong>{item.title}{item.testOnly && ' · 测试'}</strong><small>{new Date(item.createdAt).toLocaleString()} · {item.totalCount} 条</small></span><small>{statusLabel(item.status, item)}</small></Link></li>)}</ul>}</section><section className="card">{batch ? <><div className="section-title"><h2>{batch.title}{batch.testOnly && ' · 测试'}</h2><span>{batch.succeededCount} / {batch.totalCount} 已完成</span></div><p className="workflow-summary">{statusLabel(batch.status, batch)}</p><ul className="project-list">{batch.items.map((item) => <li key={item.id}><span><strong>{String(item.ordinal).padStart(2, '0')} · {item.title}</strong><small>{itemStateLabel(item.state, item.error, item.exportStatus, item.exportError)}</small>{item.exportStatus === 'FAILED' && item.exportId && <button type="button" onClick={() => void retryExport(item.exportId!)}>重试导出</button>}{item.outputPath && <video className="history-preview" controls preload="metadata" src={`/api/v1/edit/batches/${encodeURIComponent(batch.id)}/items/${encodeURIComponent(item.id)}/output`} />}</span></li>)}</ul><div className="entry-actions"><span>第 {batch.page} 页</span><button type="button" onClick={() => setDetailPage((value) => Math.max(1, value - 1))} disabled={batch.page <= 1}>上一页</button><button type="button" onClick={() => setDetailPage((value) => value + 1)} disabled={batch.items.length < batch.pageSize}>下一页</button></div><div className="entry-actions"><button type="button" onClick={() => void exportFiles()} disabled={batch.succeededCount === 0 || exportPending}>导出成片</button><button type="button" onClick={() => void retry()} disabled={batch.failedCount === 0}>重试失败任务</button>{batch.mode === 'MIX' && batch.totalCount === 1 && <Link className="module-nav-link" href={`/edit/mix?copy=${encodeURIComponent(batch.id)}`}>满意，开始全部混剪</Link>}<Link className="module-nav-link" href={`/edit/${batch.mode === 'SCRIPT' ? 'script' : 'mix'}?copy=${encodeURIComponent(batch.id)}`}>复制任务</Link></div>{batch.outputRoot && <div className="entry-actions"><p className="muted">输出目录：{batch.outputRoot}</p><button type="button" onClick={() => void copyOutputPath()}>复制输出路径</button></div>}</> : <p className="muted">从左侧选择一条剪辑记录。</p>}</section></div>{message && <p className="status">{message}</p>}</main>;
}

export default function EditHistoryPage() { return <Suspense fallback={<main className="shell"><p className="muted">正在加载剪辑记录…</p></main>}><EditHistoryContent /></Suspense>; }
