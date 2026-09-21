'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type Item = { assetId: string; fileName: string; durationMs: number; tags: string[] };
type Query = { id: string; visualNeed: string };
type Judgment = { queryId: string; assetId: string; label: string };
type Dataset = { id: string; name: string; version: number; snapshotId: string | null; items: Item[]; queries: Query[]; judgments: Judgment[] };
const labels = ['BEST', 'USABLE', 'UNUSABLE', 'FORBIDDEN'] as const;

export default function EvaluationDetailPage({ params }: { params: { id: string } }) {
  const [dataset, setDataset] = useState<Dataset | null>(null); const [queryIndex, setQueryIndex] = useState(0); const [page, setPage] = useState(0); const [message, setMessage] = useState('');
  const load = async () => { const response = await fetch(`/api/v1/edit/v3/evaluation-sets/${encodeURIComponent(params.id)}`); if (response.ok) setDataset(await response.json() as Dataset); };
  useEffect(() => { void load(); }, [params.id]);
  const current = dataset?.queries[queryIndex]; const visibleItems = useMemo(() => (dataset?.items || []).slice(page * 24, page * 24 + 24), [dataset?.items, page]);
  const judgment = (assetId: string) => dataset?.judgments.find((item) => item.queryId === current?.id && item.assetId === assetId)?.label;
  const save = async (assetId: string, label: typeof labels[number]) => { if (!current) return; const response = await fetch(`/api/v1/edit/v3/evaluation-sets/${encodeURIComponent(params.id)}/judgments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queryId: current.id, assetId, label }) }); if (!response.ok) { setMessage('判定保存失败'); return; } setMessage('人工判定已保存'); await load(); };
  const completed = dataset?.queries.filter((query) => dataset.judgments.some((item) => item.queryId === query.id)).length || 0;
  return <main className="shell"><header className="page-header"><p className="eyebrow">V3.4 / Gold Set</p><div className="page-header-row"><div><h1>{dataset?.name || 'Evaluation'}</h1><p className="muted">人工事实 · {completed}/{dataset?.queries.length || 0} Visual Needs 已开始判定</p></div><Link className="module-nav-link" href="/edit/script/v3/evaluation">返回列表</Link></div></header>{!dataset ? <section className="card">正在加载…</section> : <><section className="card"><div className="section-title"><h2>Visual Needs</h2><span>已完成 {completed} · 未完成 {dataset.queries.length - completed}</span></div><div className="entry-actions">{dataset.queries.map((query, index) => <button type="button" key={query.id} className={index === queryIndex ? 'selected' : ''} onClick={() => { setQueryIndex(index); setPage(0); }}>{index + 1}. {query.visualNeed}</button>)}</div></section><section className="card"><div className="section-title"><div><h2>{current?.visualNeed}</h2><p className="muted">候选素材每页 24 条，避免一次渲染整个素材库。</p></div><span>{page * 24 + 1}–{Math.min((page + 1) * 24, dataset.items.length)} / {dataset.items.length}</span></div><div className="material-thumb-grid">{visibleItems.map((item) => <article className="card" key={item.assetId}>{dataset.snapshotId && <video muted preload="none" controls className="history-preview" src={`/api/v1/edit/v3/media/${encodeURIComponent(item.assetId)}?snapshotId=${encodeURIComponent(dataset.snapshotId)}`} /> }<strong>{item.fileName}</strong><small>{item.tags.join('、') || '无标签'} · {judgment(item.assetId) || '未判断'}</small><div className="entry-actions">{labels.map((label) => <button type="button" key={label} className={judgment(item.assetId) === label ? 'selected' : ''} onClick={() => void save(item.assetId, label)}>{label === 'BEST' ? '最佳' : label === 'USABLE' ? '可用' : label === 'UNUSABLE' ? '不可用' : '禁止'}</button>)}</div></article>)}</div><div className="entry-actions"><button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>上一页</button><button type="button" disabled={(page + 1) * 24 >= dataset.items.length} onClick={() => setPage((value) => value + 1)}>下一页</button></div>{message && <p className="status">{message}</p>}</section></>}</main>;
}
