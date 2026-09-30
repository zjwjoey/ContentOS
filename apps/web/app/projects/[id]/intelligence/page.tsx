'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

type Asset = { id: string; originalName: string; kind: string; lifecycle: string; metadata: { durationMs?: number; tags?: string[] } };
type SearchResult = { assetId: string; score: number; summary: string; tags: string[] };

export default function IntelligentEditingPage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const [assets, setAssets] = useState<Asset[]>([]); const [query, setQuery] = useState(''); const [results, setResults] = useState<SearchResult[]>([]); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => { const response = await fetch(`/api/v1/projects/${projectId}/assets?kind=VIDEO`); if (response.ok) setAssets(((await response.json()) as { items: Asset[] }).items.filter((asset) => asset.lifecycle === 'READY')); }, [projectId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const analyze = async () => { setBusy(true); let accepted = 0; for (const asset of assets) { const response = await fetch(`/api/v1/projects/${projectId}/intelligence/analyses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId: asset.id }) }); if (response.ok) accepted += 1; } setNotice(`${accepted} 个素材已进入 MEDIA_ANALYSIS 队列；worker 完成后可搜索分析结果。`); setBusy(false); };
  const search = async () => { const response = await fetch(`/api/v1/projects/${projectId}/intelligence/search?q=${encodeURIComponent(query)}`); if (response.ok) setResults(((await response.json()) as { items: SearchResult[] }).items); };
  return <main className="shell"><header><p className="eyebrow">Project / {projectId}</p><h1>Intelligent Editing V1.5</h1><p className="muted">复用现有 Asset 与 Edit Manifest；分析和 planner 通过独立 Job/worker 运行，Fake provider 默认可用。</p><nav className="module-nav"><Link href={`/projects/${projectId}/assets`}>返回素材库</Link><Link href={`/projects/${projectId}/video`}>查看视频工作区</Link></nav></header><section className="grid"><section className="card"><div className="section-title"><h2>媒体智能分析</h2><span>{assets.length} 个 READY 视频</span></div><p className="muted">技术信息、镜头、关键帧引用、ASR、视觉标签和 embedding 会写入独立分析记录。</p><button type="button" onClick={() => void analyze()} disabled={busy || assets.length === 0}>{busy ? '正在入队…' : '分析全部 READY 视频'}</button>{notice && <p className="status">{notice}</p>}<ul className="revision-list">{assets.map((asset) => <li key={asset.id}><strong>{asset.originalName}</strong><span>{asset.id} · {asset.metadata.durationMs ? `${Math.round(asset.metadata.durationMs / 1000)} 秒` : '时长待分析'}</span></li>)}</ul></section><section className="card"><div className="section-title"><h2>语义素材搜索</h2><span>analysis results</span></div><div className="grid"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：人物走进门店" /><button type="button" onClick={() => void search()} disabled={!query.trim()}>搜索</button></div><ul className="revision-list">{results.map((result) => <li key={result.assetId}><strong>{result.assetId}</strong><span>score {result.score.toFixed(2)} · {result.tags.join('、')}</span><small>{result.summary}</small></li>)}</ul>{results.length === 0 && <p className="muted">输入查询后查看有证据的素材结果。</p>}</section></section></main>;
}
