'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ManifestTimeline } from '../../../../components/video/manifest-timeline';
import { ClipInspector } from '../../../../components/video/clip-inspector';
import { StatusBadge } from '../../../_components/status-badge';

type Asset = { id: string; kind: 'VIDEO' | 'AUDIO' | string; lifecycle: string; byteSize: number; checksum: string; originalName: string; metadata: { durationMs?: number; width?: number; height?: number; format?: string } };
type Snapshot = { projectId: string; director: { ready: boolean; briefId?: string; scriptRevisionId?: string; storyboardRevisionId?: string }; sourceAssets: Asset[]; voiceAssets: Asset[]; currentRender: { renderId: string; outputAssetId: string; status: string } | null; renderHistory: Array<{ renderId: string; outputAssetId?: string; status: string; createdAt?: string }>; job: { id: string; state: string; attemptCount: number; maxAttempts: number; errorCode?: string; errorMessage?: string } | null; approval: { targetType: 'RENDER'; targetId: string; targetRevisionId: string; status: string } | null };
type ManifestClip = { assetId: string; sourceInMs: number; durationMs: number; transition: 'cut' | 'fade' };
type ManifestRecord = { id: string; revision: number; status: 'PERSISTED' | 'SUPERSEDED'; parentManifestId: string | null; editOperations: Array<Record<string, unknown>>; createdBy: string | null; manifest: { timeline: ManifestClip[]; seed: number } };
type ApiError = { error?: { message?: string } };

async function responseMessage(response: Response, fallback: string): Promise<string> { try { const data = await response.json() as ApiError; return data.error?.message || fallback; } catch { return fallback; } }
function formatBytes(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

export default function VideoPage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [voiceAssetId, setVoiceAssetId] = useState('');
  const [duration, setDuration] = useState(0);
  const [subtitleText, setSubtitleText] = useState('');
  const [seed, setSeed] = useState(1);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [manifests, setManifests] = useState<ManifestRecord[]>([]);
  const [activeManifest, setActiveManifest] = useState<ManifestRecord | null>(null);
  const [pendingOperations, setPendingOperations] = useState<Array<Record<string, unknown>>>([]);
  const [trimClipIndex, setTrimClipIndex] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimDuration, setTrimDuration] = useState(1000);
  const [editIdempotencyKey, setEditIdempotencyKey] = useState('');

  const refreshManifests = useCallback(async () => {
    const response = await fetch(`/api/v1/projects/${projectId}/video/manifests`);
    if (!response.ok) return;
    const next = await response.json() as { items: ManifestRecord[] };
    setManifests(next.items);
    setActiveManifest((current) => current || next.items.find((item) => item.status === 'PERSISTED') || next.items[0] || null);
  }, [projectId]);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/v1/projects/${projectId}/video`);
    if (!response.ok) { setMessage(await responseMessage(response, 'Video 工作台读取失败。')); return; }
    const next = await response.json() as Snapshot;
    setSnapshot(next);
    await refreshManifests();
    if (selected.length === 0 && next.sourceAssets.length > 0) setSelected([next.sourceAssets[0].id]);
    if (duration === 0 && next.sourceAssets[0]?.metadata.durationMs) setDuration(Math.max(1000, Math.round(next.sourceAssets[0].metadata.durationMs)));
  }, [projectId, selected.length, duration, refreshManifests]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!snapshot?.job || !['QUEUED', 'RUNNING', 'RETRY_WAIT', 'CANCEL_REQUESTED'].includes(snapshot.job.state)) return;
    const timer = window.setInterval(() => { void refresh(); }, 1000);
    return () => window.clearInterval(timer);
  }, [snapshot?.job?.id, snapshot?.job?.state, refresh]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggleSource = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const createRender = async () => {
    setBusy(true); setMessage('');
    const response = await fetch(`/api/v1/projects/${projectId}/video/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ videoAssetIds: selected, ...(voiceAssetId ? { voiceAssetId } : {}), ...(duration > 0 ? { targetDurationMs: duration } : {}), ...(subtitleText ? { subtitleText } : {}), seed }) });
    setBusy(false);
    if (!response.ok) { setMessage(await responseMessage(response, '渲染 Job 创建失败。')); return; }
    const job = await response.json() as { id: string };
    setMessage(`Video Job ${job.id} 已入队。`); await refresh();
  };
  const cancelRender = async () => {
    if (!snapshot?.job) return;
    const response = await fetch(`/api/v1/projects/${projectId}/video/jobs/${snapshot.job.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    setMessage(response.ok ? 'Video Job 已请求取消。' : await responseMessage(response, '取消失败。')); await refresh();
  };
  const sendToApproval = async () => {
    if (!snapshot?.currentRender) return;
    const target = snapshot.currentRender;
    const response = await fetch(`/api/v1/projects/${projectId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetType: 'RENDER', targetId: target.renderId, targetRevisionId: target.outputAssetId, status: 'PENDING', approver: 'operator', evidence: { source: 'video-workspace' } }) });
    setMessage(response.ok ? `Render ${target.renderId} 已送往 Approval Gate。` : await responseMessage(response, '创建成片 Approval 失败。')); await refresh();
  };

  const chooseManifest = async (manifestId: string) => {
    const response = await fetch(`/api/v1/projects/${projectId}/video/manifests/${manifestId}`);
    if (!response.ok) { setMessage(await responseMessage(response, 'Manifest 读取失败。')); return; }
    setActiveManifest(await response.json() as ManifestRecord);
    setPendingOperations([]);
  };
  const addTrim = () => setPendingOperations((current) => [...current, { type: 'TRIM', clipIndex: trimClipIndex, sourceInMs: trimStart, durationMs: trimDuration }]);
  const addRemove = (clipIndex: number) => setPendingOperations((current) => [...current, { type: 'REMOVE', clipIndex }]);
  const addMove = (clipIndex: number, direction: -1 | 1) => {
    if (!activeManifest || pendingOperations.length > 0) return;
    const indexes = activeManifest.manifest.timeline.map((_, index) => index);
    const target = clipIndex + direction;
    if (target < 0 || target >= indexes.length) return;
    [indexes[clipIndex], indexes[target]] = [indexes[target]!, indexes[clipIndex]!];
    setPendingOperations([{ type: 'REORDER', clipIndexes: indexes }]);
  };
  const createQuickEdit = async () => {
    if (!activeManifest || activeManifest.status === 'SUPERSEDED' || pendingOperations.length === 0) return;
    setBusy(true); setMessage('');
    const idempotencyKey = editIdempotencyKey || `ui-${globalThis.crypto.randomUUID()}`;
    setEditIdempotencyKey(idempotencyKey);
    const response = await fetch(`/api/v1/projects/${projectId}/video/adjustments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentManifestId: activeManifest.id, operations: pendingOperations, createdBy: 'operator', idempotencyKey }) });
    setBusy(false);
    if (!response.ok) { setMessage(await responseMessage(response, '视频调整版本创建失败。')); return; }
    const next = await response.json() as ManifestRecord;
    setActiveManifest(next); setPendingOperations([]); setEditIdempotencyKey(''); setMessage(`Manifest v${next.revision} 已创建，可创建精确渲染 Job。`); await refreshManifests();
  };
  const renderManifest = async () => {
    if (!activeManifest) return;
    setBusy(true);
    const response = await fetch(`/api/v1/projects/${projectId}/video/manifests/${activeManifest.id}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    setBusy(false);
    setMessage(response.ok ? `Manifest v${activeManifest.revision} 的渲染 Job 已入队。` : await responseMessage(response, 'Manifest 渲染 Job 创建失败。'));
    await refresh();
  };

  const hasRunningJob = Boolean(snapshot?.job && ['QUEUED', 'RUNNING', 'RETRY_WAIT', 'CANCEL_REQUESTED'].includes(snapshot.job.state));
  return <main className="shell"><header><p className="eyebrow">Project / {projectId}</p><h1>Video 工作台</h1><p className="muted">只使用已批准 Director pair 和 READY 素材；渲染通过 Durable Job 执行。</p><nav className="module-nav"><Link href={`/projects/${projectId}/assets`}>Assets</Link><Link href={`/projects/${projectId}/director`}>Director</Link><Link href={`/projects/${projectId}/approvals`}>Approval Gate</Link></nav></header>
    <section className="grid"><section className="card"><div className="section-title"><h2>渲染输入</h2><span>{snapshot?.director.ready ? 'Director 已就绪' : '等待 Director'}</span></div><p className="muted">{snapshot?.director.ready ? `Script ${snapshot.director.scriptRevisionId} · Storyboard ${snapshot.director.storyboardRevisionId}` : '请先接受 Script 并批准绑定的 Storyboard。'}</p><fieldset disabled={!snapshot?.director.ready || hasRunningJob || busy}><legend>选择视频素材</legend>{snapshot?.sourceAssets.map((asset) => <label key={asset.id} className="checkbox-row"><input type="checkbox" checked={selectedSet.has(asset.id)} onChange={() => toggleSource(asset.id)} />{asset.originalName} · {formatBytes(asset.byteSize)}{asset.metadata.width && asset.metadata.height ? ` · ${asset.metadata.width}×${asset.metadata.height}` : ''}</label>)}{snapshot?.sourceAssets.length === 0 && <p className="muted">暂无 READY 视频素材，请先到 Assets 上传。</p>}</fieldset><label>配音素材<select value={voiceAssetId} onChange={(event) => setVoiceAssetId(event.target.value)} disabled={!snapshot?.director.ready || hasRunningJob || busy}><option value="">不使用配音</option>{snapshot?.voiceAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName}</option>)}</select></label><label>目标时长（毫秒）<input type="number" min={1000} value={duration} onChange={(event) => setDuration(Number(event.target.value))} disabled={hasRunningJob || busy} /></label><label>字幕文本<textarea value={subtitleText} onChange={(event) => setSubtitleText(event.target.value)} disabled={hasRunningJob || busy} placeholder="可选" /></label><label>Seed<input type="number" value={seed} onChange={(event) => setSeed(Number(event.target.value))} disabled={hasRunningJob || busy} /></label><button type="button" onClick={() => void createRender()} disabled={!snapshot?.director.ready || selected.length === 0 || hasRunningJob || busy}>创建渲染 Job</button>{hasRunningJob && <button type="button" onClick={() => void cancelRender()}>取消 Job</button>}{message && <p className="status">{message}</p>}</section>
      <section className="card"><div className="section-title"><h2>Job 与成片</h2><span>{snapshot?.job?.state || '—'}</span></div>{snapshot?.job && <p className="status">{snapshot.job.id} · {snapshot.job.state} · 尝试 {snapshot.job.attemptCount}/{snapshot.job.maxAttempts}{snapshot.job.errorCode ? ` · ${snapshot.job.errorCode}` : ''}</p>}{snapshot?.job?.errorMessage && <p className="muted">{snapshot.job.errorMessage}</p>}{snapshot?.currentRender && <><p className="status">当前 Render {snapshot.currentRender.renderId}</p><video controls preload="metadata" src={`/api/v1/projects/${projectId}/assets/${snapshot.currentRender.outputAssetId}/content`} /><p><button type="button" onClick={() => void sendToApproval()} disabled={Boolean(snapshot.approval)}>送往 Approval Gate</button>{snapshot.approval && <span className="muted"> 已存在 {snapshot.approval.status} 决策</span>}</p></>}{!snapshot?.currentRender && <p className="muted">渲染完成后会在这里预览输出并绑定精确 Render Approval。</p>}</section></section>
      <section className="card"><div className="section-title"><h2>视频调整 Manifest 版本 / 时间线</h2><span>{manifests.length} 个版本</span></div><div className="module-nav">{manifests.map((item) => <button type="button" key={item.id} onClick={() => void chooseManifest(item.id)} disabled={busy}>v{item.revision} · <StatusBadge status={item.status} /></button>)}</div>{activeManifest ? <><p className="muted">当前编辑目标：Manifest v{activeManifest.revision} · {activeManifest.manifest.timeline.length} 个镜头</p>{activeManifest.status === 'SUPERSEDED' && <p className="status">历史 Manifest 仅供查看，但仍可精确渲染。</p>}<ManifestTimeline clips={activeManifest.manifest.timeline} selectedIndex={trimClipIndex} onSelect={(index) => { setTrimClipIndex(index); setTrimStart(activeManifest.manifest.timeline[index]?.sourceInMs || 0); setTrimDuration(activeManifest.manifest.timeline[index]?.durationMs || 1000); }} /><div className="inspector-actions"><ClipInspector clip={activeManifest.manifest.timeline[trimClipIndex]} index={trimClipIndex} clipCount={activeManifest.manifest.timeline.length} replacementAssets={snapshot?.sourceAssets || []} editable={activeManifest.status !== 'SUPERSEDED'} onOperation={(operation) => setPendingOperations((current) => [...current, operation])} /></div><label>裁剪镜头索引<input type="number" min={0} value={trimClipIndex} onChange={(event) => setTrimClipIndex(Number(event.target.value))} disabled={busy || activeManifest.status === 'SUPERSEDED'} /></label><label>起始毫秒<input type="number" min={0} value={trimStart} onChange={(event) => setTrimStart(Number(event.target.value))} disabled={busy || activeManifest.status === 'SUPERSEDED'} /></label><label>时长毫秒<input type="number" min={1} value={trimDuration} onChange={(event) => setTrimDuration(Number(event.target.value))} disabled={busy || activeManifest.status === 'SUPERSEDED'} /></label><button type="button" onClick={addTrim} disabled={busy || activeManifest.status === 'SUPERSEDED'}>加入 TRIM 操作</button>{pendingOperations.length > 0 && <p className="status">待提交操作：{pendingOperations.length} 个（按顺序应用）</p>}<button type="button" onClick={() => void createQuickEdit()} disabled={busy || activeManifest.status === 'SUPERSEDED' || pendingOperations.length === 0}>生成视频调整版本</button><button type="button" onClick={() => void renderManifest()} disabled={busy || pendingOperations.length > 0}>创建精确渲染 Job</button></> : <p className="muted">先创建一次渲染 Job，系统会生成可编辑的 Manifest 版本。</p>}</section><section className="card"><div className="section-title"><h2>Render 历史</h2><span>{snapshot?.renderHistory.length || 0} 条</span></div><ul className="revision-list">{snapshot?.renderHistory.map((render) => <li key={render.renderId}><strong>{render.renderId}</strong><span>{render.status}</span>{render.outputAssetId && <small>Output Asset {render.outputAssetId}</small>}</li>)}</ul></section>
  </main>;
}
