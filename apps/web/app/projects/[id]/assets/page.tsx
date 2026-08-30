'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';

type Asset = { id: string; kind: 'VIDEO' | 'AUDIO' | 'VIDEO_RENDER'; lifecycle: string; byteSize: number; checksum: string; originalName: string; metadata: { durationMs?: number; width?: number; height?: number; format?: string } };
type AssetImport = { id: string; originalName: string; kind: string; byteSize: number; state: string; outputAssetId?: string | null; errorMessage?: string | null };
const stateLabel: Record<string, string> = { STAGED: '上传中', QUEUED: '排队中', PROCESSING: '处理中', READY: '可用', DEDUPED: '已去重', FAILED: '失败', CANCELLED: '已取消' };
const terminal = new Set(['READY', 'DEDUPED', 'FAILED', 'CANCELLED']);
async function message(response: Response): Promise<string> { try { return (await response.json() as { error?: { message?: string } }).error?.message || '请求失败'; } catch { return '请求失败'; } }

export default function AssetsPage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const [imports, setImports] = useState<AssetImport[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    const [importsResponse, assetsResponse] = await Promise.all([fetch(`/api/v1/projects/${projectId}/asset-imports`), fetch(`/api/v1/projects/${projectId}/assets`)]);
    if (importsResponse.ok) setImports((await importsResponse.json() as { items: AssetImport[] }).items);
    if (assetsResponse.ok) setAssets((await assetsResponse.json() as { items: Asset[] }).items.filter((item) => ['READY', 'DEDUPED'].includes(item.lifecycle)));
  }, [projectId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (!imports.some((item) => !terminal.has(item.state))) return; const timer = window.setInterval(() => { void refresh(); }, 700); return () => window.clearInterval(timer); }, [imports, refresh]);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    setBusy(true); setNotice(''); const form = new FormData(); form.append('file', file);
    const response = await fetch(`/api/v1/projects/${projectId}/asset-imports`, { method: 'POST', body: form });
    setNotice(response.ok ? '文件已上传并进入 Asset Import Job。' : await message(response));
    if (response.ok) await refresh(); setBusy(false); event.target.value = '';
  };

  return <main className="shell"><header><p className="eyebrow">Project / {projectId}</p><h1>Assets 工作台</h1><p className="muted">上传只负责安全落盘和入队，校验、探测、去重与入库由 Asset Worker 完成。</p><nav className="module-nav"><Link href={`/projects/${projectId}`}>项目总控</Link><Link href={`/projects/${projectId}/director`}>进入 Director</Link></nav></header>
    <section className="card"><div className="section-title"><h2>上传素材</h2><span>视频 / 音频</span></div><label className="upload-box">选择文件<input type="file" accept="video/*,audio/*" onChange={(event) => void upload(event)} disabled={busy} /></label>{notice && <p className="status">{notice}</p>}</section>
    <section className="grid"><section className="card"><div className="section-title"><h2>Import 队列</h2><span>{imports.length} 条</span></div><ul className="revision-list">{imports.map((item) => <li key={item.id}><strong>{item.originalName}</strong><span>{stateLabel[item.state] || item.state} · {item.kind} · {item.byteSize} bytes</span>{item.errorMessage && <small>{item.errorMessage}</small>}</li>)}</ul>{imports.length === 0 && <p className="muted">还没有上传素材。</p>}</section><section className="card"><div className="section-title"><h2>可用素材</h2><span>{assets.length} 个</span></div><ul className="revision-list">{assets.map((asset) => <li key={asset.id}><strong>{asset.originalName}</strong><span>{asset.kind} · {asset.lifecycle} · {asset.byteSize} bytes</span><small>{asset.metadata.width ? `${asset.metadata.width}×${asset.metadata.height}` : ''} {asset.metadata.durationMs ? `${Math.round(asset.metadata.durationMs / 1000)} 秒` : ''}</small>{asset.kind === 'VIDEO' || asset.kind === 'VIDEO_RENDER' ? <video controls preload="metadata" src={`/api/v1/projects/${projectId}/assets/${asset.id}/content`} /> : <audio controls preload="metadata" src={`/api/v1/projects/${projectId}/assets/${asset.id}/content`} />}</li>)}</ul>{assets.length === 0 && <p className="muted">Asset Worker 完成后，素材会出现在这里。</p>}</section></section>
  </main>;
}
