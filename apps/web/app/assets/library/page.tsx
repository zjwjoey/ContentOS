'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Shot = { index: number; sourceInMs: number; sourceOutMs: number; confidence: number; snapshotId: string };
type Asset = {
  fileId: string;
  fileName: string;
  relativePath: string;
  sourcePath?: string;
  durationMs: number;
  width: number;
  height: number;
  sourceFingerprint?: string;
  tags: string[];
  usageCount?: number;
  candidateCount?: number;
  selectedCount?: number;
  finalUseCount?: number;
  replaceCount?: number;
  jianyingUseCount?: number;
  available: boolean;
  gold?: boolean;
  disabled?: boolean;
  lastUsedAt?: string;
  thumbnailStatus?: string;
  shots?: Shot[];
};

function seconds(value: number): string { return `${Math.round(value / 1000)}s`; }

export default function AssetLibraryPage() {
  const [workspaceId] = useState(() => typeof window === 'undefined' ? 'workspace-v3' : window.localStorage.getItem('contentos-v3-workspace') || 'workspace-v3');
  const [items, setItems] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [batchTags, setBatchTags] = useState('');
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const [relinkDrafts, setRelinkDrafts] = useState<Record<string, string>>({});
  const [relinkConfirm, setRelinkConfirm] = useState<Record<string, boolean>>({});

  const load = async (nextPage = page) => {
    const params = new URLSearchParams({ workspaceId, page: String(nextPage), pageSize: '50' });
    if (query.trim()) params.set('query', query.trim());
    const response = await fetch(`/api/v1/video/local-media/index?${params.toString()}`);
    if (!response.ok) { setMessage('当前工作区还没有完成本地素材扫描。'); return; }
    const data = await response.json() as { items: Asset[]; total: number };
    setItems(data.items); setTotal(data.total); setPage(nextPage);
  };

  useEffect(() => { void load(1); }, [workspaceId]);

  const update = async (fileId: string, body: Record<string, unknown>) => {
    const response = await fetch(`/api/v1/video/local-media/index/${encodeURIComponent(fileId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) { setMessage('素材信息保存失败。'); return; }
    setMessage('素材信息已保存。'); await load();
  };

  const applyBatchTags = async () => {
    const tags = batchTags.split(/[，,]/u).map((tag) => tag.trim()).filter(Boolean);
    if (!selectedFileIds.length || !tags.length) return;
    const response = await fetch(`/api/v1/video/local-media/index/batch/tags?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileIds: selectedFileIds, tags }) });
    const data = await response.json() as { updated?: number; error?: { code?: string } };
    if (!response.ok) { setMessage(data.error?.code || '批量标签保存失败。'); return; }
    setMessage(`已为 ${data.updated || 0} 个素材保存标签。`); setBatchTags(''); setSelectedFileIds([]); await load();
  };

  const relink = async (fileId: string) => {
    const sourcePath = relinkDrafts[fileId]?.trim();
    if (!sourcePath) return;
    const force = Boolean(relinkConfirm[fileId]);
    const response = await fetch(`/api/v1/video/local-media/index/${encodeURIComponent(fileId)}/relink?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourcePath, force }) });
    const data = await response.json() as { error?: { code?: string }; confidence?: string };
    if (!response.ok) {
      if (data.error?.code === 'RELINK_CONFIRMATION_REQUIRED') { setRelinkConfirm((current) => ({ ...current, [fileId]: true })); setMessage('文件信息接近但指纹不同，请确认后再次点击“仍替换”。'); }
      else setMessage(data.error?.code === 'RELINK_FINGERPRINT_MISMATCH' ? '新文件与原素材差异较大，已拒绝静默替换。' : '重新定位失败。');
      return;
    }
    setRelinkConfirm((current) => ({ ...current, [fileId]: false })); setMessage(`重新定位成功（${data.confidence || '已确认'}）。`); await load();
  };

  const pickRelinkFile = async (fileId: string) => {
    const response = await fetch('/api/v1/local-paths/pick-file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'PRIORITY_ASSET' }) });
    const data = await response.json() as { path?: string; cancelled?: boolean; error?: { message?: string } };
    if (data.path) setRelinkDrafts((current) => ({ ...current, [fileId]: data.path! }));
    else if (!data.cancelled) setMessage(data.error?.message || '无法选择素材文件。');
  };

  const contentUrl = (fileId: string) => `/api/v1/video/local-media/content?workspaceId=${encodeURIComponent(workspaceId)}&sourceRootId=${encodeURIComponent(fileId.split(':', 1)[0] || '')}&fileId=${encodeURIComponent(fileId)}`;

  return <main className="shell">
    <header className="page-header"><p className="eyebrow">ContentOS / Asset Library</p><div className="page-header-row"><div><h1>长期素材库</h1><p className="muted">管理工作区长期素材索引；素材池仍是某次剪辑的固定快照。分页、标签、Gold、使用统计和 Missing 状态均来自已有本地素材索引。</p></div><Link className="module-nav-link" href="/edit/script/v3">进入脚本剪辑 V3</Link></div></header>
    <section className="card"><div className="inline-field"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名、相对路径或人工标签" /><button type="button" onClick={() => void load(1)}>查询</button><span>{total} 个素材</span></div>{selectedFileIds.length > 0 && <div className="inline-field"><span>已选择 {selectedFileIds.length} 个素材</span><input value={batchTags} onChange={(event) => setBatchTags(event.target.value)} placeholder="批量添加标签，逗号分隔" /><button type="button" onClick={() => void applyBatchTags()}>批量添加标签</button><button type="button" onClick={() => setSelectedFileIds([])}>清除选择</button></div>}{message && <p className="status">{message}</p>}</section>
    <section className="material-thumb-grid">{items.length === 0 ? <section className="card"><p className="muted">暂无长期素材。请先在脚本剪辑 V3 扫描素材文件夹。</p></section> : items.map((item) => {
      const fileId = item.fileId; const selected = selectedFileIds.includes(fileId);
      return <article className="card" key={fileId}>
        <label className="checkbox"><input type="checkbox" checked={selected} onChange={(event) => setSelectedFileIds((current) => event.target.checked ? [...new Set([...current, fileId])] : current.filter((id) => id !== fileId))} />选择素材</label>
        <div className="page-header-row"><div><h2>{item.fileName}</h2><p className="muted">{item.relativePath} · {item.width}×{item.height} · {seconds(item.durationMs)} · {item.available ? 'AVAILABLE' : 'MISSING'}{item.disabled ? ' · DISABLED' : ''}</p></div><span>{item.gold ? 'Gold' : '—'}</span></div>
        {item.available && <video controls preload="none" className="history-preview" src={contentUrl(fileId)} />}
        {!item.available && <p className="status">素材缺失：历史标签、Gold 和使用记录仍保留。</p>}
        <details><summary>完整路径</summary><code>{item.sourcePath || '未记录'}</code></details>
        <small>来源：本地素材扫描 · 分析状态：{item.thumbnailStatus || '未开始'}</small><small>指纹：{item.sourceFingerprint || '未记录'} · 最近使用：{item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : '从未'}</small><small>使用：候选 {item.candidateCount || 0} · 选择 {item.selectedCount || 0} · 成片 {item.finalUseCount || 0} · 剪映 {item.jianyingUseCount || 0} · 替换 {item.replaceCount || 0}</small>
        {item.shots && item.shots.length > 0 && <details><summary>Shots：{item.shots.length}</summary><div>{item.shots.map((shot) => <div className="card" key={`${shot.snapshotId}-${shot.index}`}><video controls preload="none" className="history-preview" src={contentUrl(fileId)} onLoadedMetadata={(event) => { event.currentTarget.currentTime = shot.sourceInMs / 1000; }} onTimeUpdate={(event) => { if (event.currentTarget.currentTime >= shot.sourceOutMs / 1000) event.currentTarget.pause(); }} /><div className="inline-field"><span>镜头 {shot.index + 1} · {seconds(shot.sourceInMs)} → {seconds(shot.sourceOutMs)} · 片段 {seconds(shot.sourceOutMs - shot.sourceInMs)} · 置信度 {shot.confidence.toFixed(2)}</span><Link className="module-nav-link" href={`/edit/script/v3?snapshotId=${encodeURIComponent(shot.snapshotId)}&assetId=${encodeURIComponent(fileId)}&shotIn=${shot.sourceInMs}&shotOut=${shot.sourceOutMs}`}>在脚本剪辑中作为候选使用</Link></div></div>)}</div></details>}
        {!item.shots?.length && <small>Shots：尚未检测（可在脚本剪辑 V3 中检测）</small>}<p>{item.tags.join('、') || '无标签'}</p>
        <div className="inline-field"><input value={tagDrafts[fileId] ?? item.tags.join('、')} onChange={(event) => setTagDrafts((current) => ({ ...current, [fileId]: event.target.value }))} placeholder="人工标签，逗号分隔" /><button type="button" onClick={() => void update(fileId, { tags: (tagDrafts[fileId] ?? '').split(/[，,]/u).map((tag) => tag.trim()).filter(Boolean) })}>保存标签</button><button type="button" onClick={() => void update(fileId, { gold: !item.gold })}>{item.gold ? '取消 Gold' : '标记 Gold'}</button><button type="button" onClick={() => void update(fileId, { disabled: !item.disabled })}>{item.disabled ? '恢复素材' : '禁用素材'}</button></div>
        {!item.available && <div className="inline-field"><input value={relinkDrafts[fileId] || ''} onChange={(event) => setRelinkDrafts((current) => ({ ...current, [fileId]: event.target.value }))} placeholder="输入 Native Picker 返回的新路径" /><button type="button" onClick={() => void pickRelinkFile(fileId)}>选择文件</button><button type="button" onClick={() => void relink(fileId)}>{relinkConfirm[fileId] ? '仍替换' : '重新定位'}</button></div>}
      </article>;
    })}</section>
    <div className="entry-actions"><button type="button" disabled={page <= 1} onClick={() => void load(page - 1)}>上一页</button><button type="button" disabled={page * 50 >= total} onClick={() => void load(page + 1)}>下一页</button></div>
  </main>;
}
