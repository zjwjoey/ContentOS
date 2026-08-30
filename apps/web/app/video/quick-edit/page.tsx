'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AssetCard, type VideoAsset } from '../../../components/video/asset-card';
import { ClipInspector } from '../../../components/video/clip-inspector';
import { isCurrentManifest, ManifestRevisionPicker } from '../../../components/video/manifest-revision-picker';
import { ManifestTimeline, type TimelineClip } from '../../../components/video/manifest-timeline';
import { MediaPreview } from '../../../components/video/media-preview';
import { StatusBadge } from '../../_components/status-badge';
import { LoadingState } from '../../_components/feedback-state';

type DurationMode = 'AUTO' | 'CUSTOM';
type Session = { id: string; workspaceId: string; voiceAssetId: string | null; currentManifestId: string | null; seed: number; targetDurationMs: number | null; minClipDurationMs: number; maxClipDurationMs: number };
type Manifest = { id: string; revision: number; status?: string; manifest: { timeline: TimelineClip[] } };
type ImportRecord = { id: string; state: string; originalName: string; kind: string; outputAssetId?: string | null; errorMessage?: string | null };
type RenderJob = { id: string; state: string; result?: { outputAssetId?: string }; error?: { message?: string } };
type ApiError = { error?: { message?: string } };

async function responseMessage(response: Response, fallback: string): Promise<string> { try { return (await response.json() as ApiError).error?.message || fallback; } catch { return fallback; } }

export default function StandaloneQuickEditPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [assets, setAssets] = useState<VideoAsset[]>([]);
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string>();
  const [voiceAssetId, setVoiceAssetId] = useState<string>();
  const [selectedClip, setSelectedClip] = useState<number | null>(null);
  const [durationMode, setDurationMode] = useState<DurationMode>('AUTO');
  const [targetDurationSeconds, setTargetDurationSeconds] = useState(30);
  const [minClipDurationSeconds, setMinClipDurationSeconds] = useState(2);
  const [maxClipDurationSeconds, setMaxClipDurationSeconds] = useState(5);
  const [seed, setSeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [renderJob, setRenderJob] = useState<RenderJob | null>(null);
  const [outputAssetId, setOutputAssetId] = useState<string>();

  const plannerLocked = Boolean(session?.currentManifestId);
  const settingsPayload = (includeAutoNull = false) => ({ seed, ...(durationMode === 'CUSTOM' ? { targetDurationMs: targetDurationSeconds * 1000 } : includeAutoNull ? { targetDurationMs: null } : {}), minClipDurationMs: minClipDurationSeconds * 1000, maxClipDurationMs: maxClipDurationSeconds * 1000 });

  const createSession = async () => {
    setBusy(true);
    const response = await fetch('/api/v1/video/quick-edits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settingsPayload()) });
    setBusy(false);
    if (!response.ok) { setMessage(await responseMessage(response, '创建快速剪辑失败。')); return; }
    const next = await response.json() as Session;
    setSession(next); setVoiceAssetId(next.voiceAssetId || undefined); setMessage('已创建草稿会话，请上传素材并选择主配音。');
  };

  const refreshSession = useCallback(async (): Promise<Session | null> => {
    if (!session) return null;
    const response = await fetch(`/api/v1/video/quick-edits/${session.id}`);
    if (!response.ok) return null;
    const next = await response.json() as Session;
    setSession(next); setVoiceAssetId(next.voiceAssetId || undefined);
    return next;
  }, [session]);

  const refreshAssets = useCallback(async () => {
    if (!session) return;
    const response = await fetch(`/api/v1/video/quick-edits/${session.id}/assets`);
    if (!response.ok) return;
    const data = await response.json() as { items: VideoAsset[]; imports: ImportRecord[] };
    setAssets(data.items.map((asset) => ({ ...asset, contentUrl: `/api/v1/video/quick-edits/${session.id}/assets/${asset.id}/content` })));
    setImports(data.imports);
  }, [session]);

  const refreshManifests = useCallback(async (): Promise<Manifest[]> => {
    if (!session) return [];
    const response = await fetch(`/api/v1/video/quick-edits/${session.id}/manifests`);
    if (!response.ok) return [];
    const data = await response.json() as { items: Manifest[] };
    setManifests(data.items);
    return data.items;
  }, [session]);

  useEffect(() => { void refreshAssets(); void refreshManifests(); }, [refreshAssets, refreshManifests]);
  useEffect(() => {
    if (!session || !imports.some((item) => ['STAGED', 'QUEUED', 'PROCESSING'].includes(item.state))) return;
    const timer = window.setInterval(() => void refreshAssets(), 1200);
    return () => window.clearInterval(timer);
  }, [session, imports, refreshAssets]);

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!session || !event.target.files?.length) return;
    setBusy(true); const results: string[] = [];
    for (const file of Array.from(event.target.files)) {
      const form = new FormData(); form.append('file', file);
      const response = await fetch(`/api/v1/video/quick-edits/${session.id}/assets`, { method: 'POST', body: form });
      results.push(response.ok ? `${file.name} 已排队` : `${file.name}：${await responseMessage(response, '上传失败')}`);
    }
    setBusy(false); setMessage(results.join('；')); event.target.value = ''; await refreshAssets();
  };

  const chooseVoice = async (assetId: string) => {
    if (!session || !assetId || plannerLocked) return;
    setBusy(true);
    const response = await fetch(`/api/v1/video/quick-edits/${session.id}/voice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId }) });
    if (!response.ok) { setBusy(false); setMessage(await responseMessage(response, '配音选择失败。')); return; }
    const next = await response.json() as Session; setSession(next); setVoiceAssetId(next.voiceAssetId || undefined); setMessage('主配音已选择。');
    setBusy(false);
  };

  const syncSettings = async (): Promise<boolean> => {
    if (!session || plannerLocked) return true;
    const response = await fetch(`/api/v1/video/quick-edits/${session.id}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settingsPayload(true)) });
    if (!response.ok) { setMessage(await responseMessage(response, '规划设置保存失败。')); return false; }
    setSession(await response.json() as Session); return true;
  };

  const plan = async () => {
    if (!session || plannerLocked) return;
    setBusy(true);
    if (!await syncSettings()) { setBusy(false); return; }
    const response = await fetch(`/api/v1/video/quick-edits/${session.id}/plan`, { method: 'POST' });
    setBusy(false);
    if (!response.ok) { setMessage(await responseMessage(response, '生成计划失败。未设置自定义目标时，需要选择主配音。')); return; }
    const next = await response.json() as Manifest;
    const current = await refreshSession(); const revisions = await refreshManifests();
    setManifest(revisions.find((item) => item.id === current?.currentManifestId) || next); setSelectedClip(0); setMessage('Manifest 计划已生成，规划设置已锁定。');
  };

  const performAdjustment = async (operation: Record<string, unknown>) => {
    if (!session || !manifest || !isCurrentManifest(manifest.id, session.currentManifestId || undefined)) return;
    setBusy(true);
    const response = await fetch(`/api/v1/video/quick-edits/${session.id}/adjustments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operations: [operation], createdBy: 'operator' }) });
    setBusy(false);
    if (!response.ok) { setMessage(await responseMessage(response, '调整失败。')); return; }
    const returned = await response.json() as Manifest;
    const current = await refreshSession(); const revisions = await refreshManifests();
    setManifest(revisions.find((item) => item.id === current?.currentManifestId) || returned); setSelectedClip(0); setMessage(`已创建新的 Manifest Revision v${returned.revision}。`);
  };

  const selectManifest = async (id: string) => {
    if (!session || !id) return;
    const response = await fetch(`/api/v1/video/quick-edits/${session.id}/manifests/${id}`);
    if (!response.ok) { setMessage(await responseMessage(response, 'Manifest 读取失败。')); return; }
    setManifest(await response.json() as Manifest); setSelectedClip(0);
  };

  const render = async () => {
    if (!session || !manifest) return;
    setBusy(true);
    const response = await fetch(`/api/v1/video/quick-edits/${session.id}/manifests/${manifest.id}/render`, { method: 'POST' });
    setBusy(false);
    if (!response.ok) { setMessage(await responseMessage(response, '渲染入队失败。')); return; }
    setRenderJob(await response.json() as RenderJob); setOutputAssetId(undefined); setMessage('Render Job 已入队，Video Worker 正在处理。');
  };

  useEffect(() => {
    if (!renderJob || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(renderJob.state)) return;
    let disposed = false;
    const poll = async () => {
      const response = await fetch(`/api/v1/jobs/${renderJob.id}`);
      if (!response.ok || disposed) return;
      const next = await response.json() as RenderJob; if (disposed) return;
      setRenderJob(next);
      if (next.state === 'SUCCEEDED' && next.result?.outputAssetId) { setOutputAssetId(next.result.outputAssetId); await refreshAssets(); setMessage('Render 已完成，输出成片已就绪。'); }
      else if (next.state === 'FAILED') setMessage(next.error?.message || 'Render 执行失败。');
    };
    void poll(); const timer = window.setInterval(() => void poll(), 800);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [renderJob?.id, renderJob?.state, refreshAssets]);

  const selectedAsset = useMemo(() => assets.find((asset) => asset.id === selectedAssetId), [assets, selectedAssetId]);
  const selectedClipData = manifest && selectedClip !== null ? manifest.manifest.timeline[selectedClip] : undefined;
  const currentManifest = isCurrentManifest(manifest?.id || '', session?.currentManifestId || undefined);

  if (!session) return <main className="shell"><div className="page-header"><p className="eyebrow">Video / Standalone</p><h1>快速剪辑</h1><p className="muted">创建草稿会话后，从素材库选择视频和配音，生成可调整的 Random Montage。</p></div><section className="card quick-start"><h2>新建快速剪辑</h2><PlannerSettings durationMode={durationMode} setDurationMode={setDurationMode} targetDurationSeconds={targetDurationSeconds} setTargetDurationSeconds={setTargetDurationSeconds} minClipDurationSeconds={minClipDurationSeconds} setMinClipDurationSeconds={setMinClipDurationSeconds} maxClipDurationSeconds={maxClipDurationSeconds} setMaxClipDurationSeconds={setMaxClipDurationSeconds} seed={seed} setSeed={setSeed} disabled={false} /><button type="button" onClick={() => void createSession()} disabled={busy}>创建草稿会话</button></section></main>;

  return <main className="shell"><div className="page-header"><p className="eyebrow">Video / Standalone · Draft</p><div className="page-header-row"><div><h1>快速剪辑工作台</h1><p className="muted">三栏编辑工作台：素材库 → 预览与时间线 → 镜头 Inspector。</p></div><div className="page-actions"><StatusBadge status={manifest ? 'READY' : 'PENDING'} /></div></div></div><section className="workspace-grid"><section className="card"><div className="section-title"><h2>素材库</h2><span>{assets.length} 个素材</span></div><fieldset disabled={plannerLocked} className="planner-settings"><legend>规划设置</legend><PlannerSettings durationMode={durationMode} setDurationMode={setDurationMode} targetDurationSeconds={targetDurationSeconds} setTargetDurationSeconds={setTargetDurationSeconds} minClipDurationSeconds={minClipDurationSeconds} setMinClipDurationSeconds={setMinClipDurationSeconds} maxClipDurationSeconds={maxClipDurationSeconds} setMaxClipDurationSeconds={setMaxClipDurationSeconds} seed={seed} setSeed={setSeed} disabled={plannerLocked} />{plannerLocked && <p className="status">当前剪辑方案已生成。如需更改配音或规划参数，请新建快速剪辑会话。</p>}</fieldset><label className="upload-box">上传视频 / 配音<input type="file" accept="video/*,audio/*" multiple onChange={(event) => void upload(event)} disabled={busy} /></label>{imports.length > 0 && <div className="asset-list">{imports.map((item) => <div className="asset-card" key={item.id}><strong>{item.originalName}</strong><span className="asset-meta">{item.kind} · <StatusBadge status={item.state} /></span></div>)}</div>}{assets.length === 0 ? <LoadingState text="上传素材后会自动导入并显示在这里。" /> : <div className="asset-list">{assets.map((asset) => <AssetCard key={asset.id} asset={asset} selected={selectedAssetId === asset.id} onSelect={() => setSelectedAssetId(asset.id)} />)}</div>}<label>主配音<select value={voiceAssetId || ''} onChange={(event) => void chooseVoice(event.target.value)} disabled={plannerLocked}><option value="">选择 READY 配音</option>{assets.filter((asset) => asset.kind === 'AUDIO' && asset.lifecycle === 'READY').map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName}</option>)}</select></label>{durationMode === 'AUTO' && !voiceAssetId && !plannerLocked && <p className="muted">未设置自定义目标时长时，需要选择主配音。</p>}</section><section className="card"><div className="section-title"><h2>预览 / 时间线</h2><span>{manifest ? `Manifest v${manifest.revision}` : '等待计划'}</span></div><MediaPreview url={selectedAsset?.contentUrl} kind={selectedAsset?.kind || 'VIDEO'} label={selectedAsset?.originalName} />{manifests.length > 0 && <ManifestRevisionPicker revisions={manifests} currentId={session.currentManifestId || undefined} onSelect={(id) => void selectManifest(id)} />}{manifest && !currentManifest && <p className="status">当前正在查看历史 Manifest v{manifest.revision}。历史版本仅供查看，但仍可精确渲染。</p>}<ManifestTimeline clips={manifest?.manifest.timeline || []} selectedIndex={selectedClip} onSelect={setSelectedClip} /><div className="toolbar"><button type="button" onClick={() => void plan()} disabled={busy || plannerLocked || assets.filter((asset) => asset.kind === 'VIDEO' && asset.lifecycle === 'READY').length === 0}>Generate Plan</button><button type="button" onClick={() => void render()} disabled={busy || !manifest}>Render 成品</button></div>{renderJob && <p className="status">Render 状态：{renderJob.state}</p>}{outputAssetId && <MediaPreview url={`/api/v1/video/quick-edits/${session.id}/assets/${outputAssetId}/content`} kind="VIDEO_RENDER" label="Render 输出成片" />}</section><section className="card"><div className="section-title"><h2>镜头 Inspector</h2><span>{selectedClipData ? `镜头 ${(selectedClip || 0) + 1}` : '未选择'}</span></div><ClipInspector clip={selectedClipData} index={selectedClip} clipCount={manifest?.manifest.timeline.length || 0} replacementAssets={assets.filter((asset) => asset.kind === 'VIDEO' && asset.lifecycle === 'READY')} editable={currentManifest} busy={busy} onOperation={(operation) => void performAdjustment(operation)} />{message && <p className="status">{message}</p>}<details><summary>会话详情</summary><p className="muted">Session {session.id}<br />Workspace {session.workspaceId}</p></details></section></section></main>;
}

function PlannerSettings({ durationMode, setDurationMode, targetDurationSeconds, setTargetDurationSeconds, minClipDurationSeconds, setMinClipDurationSeconds, maxClipDurationSeconds, setMaxClipDurationSeconds, seed, setSeed, disabled }: { durationMode: DurationMode; setDurationMode: (value: DurationMode) => void; targetDurationSeconds: number; setTargetDurationSeconds: (value: number) => void; minClipDurationSeconds: number; setMinClipDurationSeconds: (value: number) => void; maxClipDurationSeconds: number; setMaxClipDurationSeconds: (value: number) => void; seed: number; setSeed: (value: number) => void; disabled: boolean }) {
  return <div className="form-grid"><label>Seed<input type="number" value={seed} onChange={(event) => setSeed(Number(event.target.value))} disabled={disabled} /></label><label>目标时长<select value={durationMode} onChange={(event) => setDurationMode(event.target.value as DurationMode)} disabled={disabled}><option value="AUTO">自动（跟随配音）</option><option value="CUSTOM">自定义</option></select></label>{durationMode === 'CUSTOM' && <label>自定义目标时长（秒）<input type="number" min={1} value={targetDurationSeconds} onChange={(event) => setTargetDurationSeconds(Number(event.target.value))} disabled={disabled} /></label>}<label>最短镜头（秒）<input type="number" min={1} value={minClipDurationSeconds} onChange={(event) => setMinClipDurationSeconds(Number(event.target.value))} disabled={disabled} /></label><label>最长镜头（秒）<input type="number" min={1} value={maxClipDurationSeconds} onChange={(event) => setMaxClipDurationSeconds(Number(event.target.value))} disabled={disabled} /></label></div>;
}
