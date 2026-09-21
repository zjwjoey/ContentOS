'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Asset = { id: string; originalName: string; kind: string; lifecycle: string; byteSize: number; metadata: { durationMs?: number; tags?: string[] } };
export default function AssetLibraryPage() {
  const [workspaceId] = useState(() => typeof window === 'undefined' ? 'workspace-v3' : window.localStorage.getItem('contentos-v3-workspace') || 'workspace-v3');
  const [items, setItems] = useState<Asset[]>([]); const [total, setTotal] = useState(0); const [offset, setOffset] = useState(0); const [query, setQuery] = useState('');
  const load = async (nextOffset = offset) => { const response = await fetch(`/api/v1/assets/library?workspaceId=${encodeURIComponent(workspaceId)}&limit=50&offset=${nextOffset}${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''}`); if (!response.ok) return; const data = await response.json() as { items: Asset[]; total: number }; setItems(data.items); setTotal(data.total); setOffset(nextOffset); };
  useEffect(() => { void load(0); }, [workspaceId]);
  return <main className="shell"><header className="page-header"><p className="eyebrow">ContentOS / Asset Library</p><div className="page-header-row"><div><h1>长期素材库</h1><p className="muted">分页读取统一 Asset 真值；V3 Snapshot 仍然保留自己的固定快照。</p></div><Link className="module-nav-link" href="/edit/script/v3">进入脚本剪辑 V3</Link></div></header><section className="card"><div className="inline-field"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名" /><button type="button" onClick={() => void load(0)}>查询</button><span>{total} 个素材</span></div>{items.length === 0 ? <p className="muted">暂无素材。</p> : <ul className="revision-list">{items.map((item) => <li key={item.id}><strong>{item.originalName}</strong><span>{item.kind} · {item.lifecycle} · {item.metadata.durationMs ? `${Math.round(item.metadata.durationMs / 1000)}s` : '时长未知'} · {(item.metadata.tags || []).join('、') || '无标签'}</span></li>)}</ul>}<div className="entry-actions"><button type="button" disabled={offset <= 0} onClick={() => void load(Math.max(0, offset - 50))}>上一页</button><button type="button" disabled={offset + items.length >= total} onClick={() => void load(offset + 50)}>下一页</button></div></section></main>;
}
