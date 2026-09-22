'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';

type Project = { id: string; name: string };
type Voice = { id: string; name: string; provider: string; language: string; status: string; defaultSpeed: number; defaultEmotion: string; referenceAssetId?: string | null };
type AvatarClip = { id: string; name: string; status: string; durationMs?: number | null; usageCount: number };
type Avatar = { id: string; name: string; ownerName?: string; status: string; clips: AvatarClip[] };
type SpeechGeneration = { id: string; projectId: string; status: string; text: string; outputAssetId?: string | null; durationMs?: number | null; createdAt?: string; error?: { message?: string } | null };
type AvatarGeneration = { id: string; projectId: string; status: string; speechAssetId: string; outputAssetId?: string | null; createdAt?: string; error?: { message?: string } | null };
type Capability = { status: string; providerId?: string; modelVersion?: string; languages?: string[]; requiresReferenceAudio?: boolean; maxTextCharacters?: number };
type Workspace = { projectId: string; voices: Voice[]; avatars: Avatar[]; speech: SpeechGeneration[]; avatar: AvatarGeneration[] };

const statusLabel: Record<string, string> = { QUEUED: '排队中', RUNNING: '生成中', SUCCEEDED: '已完成', FAILED: '失败', CANCELLED: '已取消', DRAFT: '草稿', READY: '已就绪', DISABLED: '已禁用' };
const label = (status: string) => statusLabel[status] || status;

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message || `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export default function DigitalHumanIndexPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projectId, setProjectId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [capability, setCapability] = useState<Capability | null>(null);
  const [script, setScript] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [speed, setSpeed] = useState('1');
  const [emotion, setEmotion] = useState('natural');
  const [avatarId, setAvatarId] = useState('');
  const [clipId, setClipId] = useState('');
  const [speechAssetId, setSpeechAssetId] = useState('');
  const [sourceInMs, setSourceInMs] = useState('0');
  const [voiceName, setVoiceName] = useState('');
  const [referenceAssetId, setReferenceAssetId] = useState('');
  const [historyFilter, setHistoryFilter] = useState<'ALL' | 'SPEECH' | 'AVATAR'>('ALL');

  const active = useMemo(() => workspaces.find((item) => item.projectId === projectId) || workspaces[0], [projectId, workspaces]);
  const voices = active?.voices || [];
  const avatars = active?.avatars || [];
  const selectedAvatar = avatars.find((item) => item.id === avatarId);
  const clips = selectedAvatar?.clips.filter((item) => item.status !== 'DISABLED') || [];
  const speechHistory = workspaces.flatMap((item) => item.speech);
  const avatarHistory = workspaces.flatMap((item) => item.avatar);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const projects = (await readJson<{ items: Project[] }>(await fetch('/api/v1/projects'))).items;
      const records = await Promise.all(projects.map(async (project) => {
        const [voicesResponse, avatarsResponse, speechResponse, avatarResponse] = await Promise.all([
          fetch(`/api/v1/projects/${project.id}/digital-human/voices`),
          fetch(`/api/v1/projects/${project.id}/digital-human/avatars`),
          fetch(`/api/v1/projects/${project.id}/digital-human/speech-generations`),
          fetch(`/api/v1/projects/${project.id}/digital-human/avatar-generations`),
        ]);
        return {
          projectId: project.id,
          voices: (await readJson<{ items: Voice[] }>(voicesResponse)).items,
          avatars: (await readJson<{ items: Avatar[] }>(avatarsResponse)).items,
          speech: (await readJson<{ items: SpeechGeneration[] }>(speechResponse)).items.map((item) => ({ ...item, projectId: project.id })),
          avatar: (await readJson<{ items: AvatarGeneration[] }>(avatarResponse)).items.map((item) => ({ ...item, projectId: project.id })),
        };
      }));
      setWorkspaces(records);
      const nextProjectId = records.find((item) => item.voices.length > 0 || item.avatars.length > 0)?.projectId || records[0]?.projectId || '';
      setProjectId((current) => current && records.some((item) => item.projectId === current) ? current : nextProjectId);
      if (nextProjectId) {
        const capabilities = await readJson<{ speech: Capability }>(await fetch(`/api/v1/projects/${nextProjectId}/digital-human/capabilities`));
        setCapability(capabilities.speech);
      } else setCapability(null);
      setNotice('');
    } catch (error) { setNotice(error instanceof Error ? error.message : '数字人工作台加载失败'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!active) return;
    const voice = active.voices.find((item) => item.status === 'READY') || active.voices[0];
    const avatar = active.avatars.find((item) => item.status === 'READY') || active.avatars[0];
    setVoiceId((current) => current && active.voices.some((item) => item.id === current) ? current : voice?.id || '');
    setAvatarId((current) => current && active.avatars.some((item) => item.id === current) ? current : avatar?.id || '');
  }, [active]);
  useEffect(() => {
    const clip = selectedAvatar?.clips.find((item) => item.status === 'READY') || selectedAvatar?.clips[0];
    setClipId((current) => current && clips.some((item) => item.id === current) ? current : clip?.id || '');
  }, [selectedAvatar, clips]);

  const generateSpeech = async () => {
    if (!projectId || !voiceId || !script.trim()) return;
    setBusy(true); setNotice('');
    try {
      const result = await readJson<SpeechGeneration & { outputAssetId?: string | null }>(await fetch(`/api/v1/projects/${projectId}/digital-human/speech-generations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceProfileId: voiceId, text: script.trim(), provider: 'indextts25', model: 'indextts-2.5', language: 'zh', speed: Number(speed), emotion: emotion.trim() || 'natural' }) }));
      if (result.outputAssetId) setSpeechAssetId(result.outputAssetId);
      setNotice(result.status === 'SUCCEEDED' ? 'TTS 2.5 配音已完成。' : 'TTS 2.5 配音已提交，正在生成。');
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'TTS 2.5 配音失败'); }
    finally { setBusy(false); }
  };

  const createVoice = async () => {
    if (!projectId || !voiceName.trim()) return;
    setBusy(true); setNotice('');
    try {
      await readJson<Voice>(await fetch(`/api/v1/projects/${projectId}/digital-human/voices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: voiceName.trim(), provider: 'indextts25', language: 'zh', defaultSpeed: Number(speed), defaultEmotion: emotion.trim() || 'natural', ...(referenceAssetId.trim() ? { referenceAssetId: referenceAssetId.trim() } : {}) }) }));
      setVoiceName(''); setReferenceAssetId(''); setNotice('TTS 2.5 音色已创建。'); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : '音色创建失败'); }
    finally { setBusy(false); }
  };

  const uploadReference = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file || !projectId) return;
    setBusy(true); setNotice('正在导入参考音频…');
    try {
      const body = new FormData(); body.append('file', file);
      const initial = await readJson<{ import: { id: string; state: string; outputAssetId?: string | null } }>(await fetch(`/api/v1/projects/${projectId}/asset-imports`, { method: 'POST', body }));
      let current = initial.import;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if ((current.state === 'READY' || current.state === 'DEDUPED') && current.outputAssetId) break;
        if (current.state === 'FAILED' || current.state === 'CANCELLED') throw new Error('参考音频导入失败');
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const list = await readJson<{ items: Array<{ id: string; state: string; outputAssetId?: string | null }> }>(await fetch(`/api/v1/projects/${projectId}/asset-imports`));
        current = list.items.find((item) => item.id === initial.import.id) || current;
      }
      if (!current.outputAssetId) throw new Error('参考音频仍在处理中，请稍后重试');
      setReferenceAssetId(current.outputAssetId); setNotice('参考音频已导入，可创建 TTS 2.5 音色。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '参考音频导入失败'); }
    finally { setBusy(false); }
  };

  const generateAvatar = async () => {
    if (!projectId || !avatarId || !clipId || !speechAssetId) return;
    setBusy(true); setNotice('');
    try {
      const timingInput = { avatarProfileId: avatarId, avatarClipId: clipId, speechAssetId, sourceInMs: Number(sourceInMs) || 0 };
      const preflight = await readJson<{ status: string; checks: Array<{ status: string; message: string }>; timing?: { sourceDurationMs: number; audioDurationMs: number; targetDurationMs: number; sourceInMs: number; sourceOutMs: number } }>(await fetch(`/api/v1/projects/${projectId}/digital-human/avatar-generations/preflight`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(timingInput) }));
      if (preflight.status !== 'READY') throw new Error(preflight.checks.find((item) => item.status === 'BLOCKED')?.message || '生成前检查未通过');
      await readJson(await fetch(`/api/v1/projects/${projectId}/digital-human/avatar-generations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(timingInput) }));
      const timingNotice = preflight.timing ? `源视频 ${(preflight.timing.sourceDurationMs / 1000).toFixed(2)} 秒 · 配音 ${(preflight.timing.audioDurationMs / 1000).toFixed(2)} 秒 · 预计成片 ${(preflight.timing.targetDurationMs / 1000).toFixed(2)} 秒 · 使用 ${(preflight.timing.sourceInMs / 1000).toFixed(2)} → ${(preflight.timing.sourceOutMs / 1000).toFixed(2)} 秒` : '';
      setNotice(`数字人视频已提交，正在生成。${timingNotice ? ` ${timingNotice}` : ''}`); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : '数字人生成失败'); }
    finally { setBusy(false); }
  };

  const cancelSpeech = async (item: SpeechGeneration) => { setBusy(true); try { await fetch(`/api/v1/projects/${item.projectId}/digital-human/speech-generations/${item.id}/cancel`, { method: 'POST' }); await refresh(); } finally { setBusy(false); } };
  const retrySpeech = async (item: SpeechGeneration) => { setBusy(true); try { await fetch(`/api/v1/projects/${item.projectId}/digital-human/speech-generations/${item.id}/retry`, { method: 'POST' }); await refresh(); } finally { setBusy(false); } };

  const history = [
    ...(historyFilter === 'ALL' || historyFilter === 'SPEECH' ? speechHistory.map((item) => ({ kind: 'speech' as const, item, createdAt: item.createdAt || '' })) : []),
    ...(historyFilter === 'ALL' || historyFilter === 'AVATAR' ? avatarHistory.map((item) => ({ kind: 'avatar' as const, item, createdAt: item.createdAt || '' })) : []),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return <main className="shell">
    <header className="page-header"><p className="eyebrow">ContentOS / 数字人</p><h1>数字人工作台</h1><p className="muted">输入文案，使用 TTS 2.5 生成配音，再生成可交互的数字人视频。历史记录会自动保留。</p></header>
    {notice && <section className="card status" role="status">{notice}<button type="button" onClick={() => setNotice('')}>关闭</button></section>}
    {loading ? <section className="card"><p className="muted">正在准备数字人工作台…</p></section> : !projectId ? <section className="card form-error"><h2>还没有可用工作空间</h2><p>请先在首页创建一个内容项目，数字人工作台会自动接入，不再要求你选择项目。</p><a className="module-nav-link" href="/">返回首页</a></section> : <>
      <section className="card"><div className="section-title"><div><h2>TTS 2.5 本地配音</h2><p className="muted">模型：indextts-2.5 · 中文语音 · 生成结果自动进入历史</p></div><span className={capability?.status === 'READY' ? 'status-ok' : 'status-warn'}>{capability?.status === 'READY' ? '已连接' : '未连接'}</span></div><p className="muted">{capability?.status === 'READY' ? `TTS 2.5 已就绪${capability.providerId ? ` · ${capability.providerId}` : ''}。` : '未检测到 TTS 2.5 网关，请启动本地 IndexTTS 2.5 服务（默认 127.0.0.1:8788）。'}</p></section>
      <section className="grid grid-2">
        <section className="card"><div className="section-title"><h2>开始生成</h2><span>交互式</span></div><label>口播文案<textarea rows={7} value={script} onChange={(event) => setScript(event.target.value)} placeholder="输入要让数字人说的话…" maxLength={capability?.maxTextCharacters || 100000} /></label><div className="grid grid-2"><label>音色<select value={voiceId} onChange={(event) => setVoiceId(event.target.value)}><option value="">请选择音色</option>{voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name} · {label(voice.status)}</option>)}</select></label><label>语速<input type="number" min="0.5" max="2" step="0.05" value={speed} onChange={(event) => setSpeed(event.target.value)} /></label></div><label>情绪<input value={emotion} onChange={(event) => setEmotion(event.target.value)} placeholder="natural" /></label><div className="entry-actions"><button type="button" disabled={busy || capability?.status !== 'READY' || !voiceId || !script.trim()} onClick={() => void generateSpeech()}>生成配音（TTS 2.5）</button><details><summary>创建新音色</summary><div className="inline-field"><input value={voiceName} onChange={(event) => setVoiceName(event.target.value)} placeholder="音色名称" /><input value={referenceAssetId} onChange={(event) => setReferenceAssetId(event.target.value)} placeholder="参考音频素材 ID" /><label>上传参考音频<input type="file" accept="audio/*" disabled={busy} onChange={uploadReference} /></label><button type="button" disabled={busy || !voiceName.trim() || !referenceAssetId.trim()} onClick={() => void createVoice()}>创建音色</button></div><p className="muted">TTS 2.5 当前需要一条参考音频来创建可用音色。</p></details></div></section>
        <section className="card"><div className="section-title"><h2>数字人视频</h2><span>可交互预览</span></div><label>人物<select value={avatarId} onChange={(event) => setAvatarId(event.target.value)}><option value="">请选择人物</option>{avatars.map((avatar) => <option key={avatar.id} value={avatar.id}>{avatar.name} · {label(avatar.status)}</option>)}</select></label><label>人物底片<select value={clipId} onChange={(event) => setClipId(event.target.value)}><option value="">请选择底片</option>{clips.map((clip) => <option key={clip.id} value={clip.id}>{clip.name} · 使用 {clip.usageCount} 次</option>)}</select></label><label>配音素材 ID<input value={speechAssetId} onChange={(event) => setSpeechAssetId(event.target.value)} placeholder="生成配音后自动填入" /></label><label>源视频起始位置（毫秒）<input type="number" min="0" step="100" value={sourceInMs} onChange={(event) => setSourceInMs(event.target.value)} /></label><button type="button" disabled={busy || !avatarId || !clipId || !speechAssetId} onClick={() => void generateAvatar()}>生成数字人视频</button><p className="muted">音频时长是输出时长唯一依据；源视频按起始位置截取同等时长，超出源视频会被阻止。</p></section>
      </section>
      <section className="card"><div className="section-title"><h2>生成历史</h2><div className="entry-actions"><button type="button" className={historyFilter === 'ALL' ? 'selected' : ''} onClick={() => setHistoryFilter('ALL')}>全部</button><button type="button" className={historyFilter === 'SPEECH' ? 'selected' : ''} onClick={() => setHistoryFilter('SPEECH')}>配音</button><button type="button" className={historyFilter === 'AVATAR' ? 'selected' : ''} onClick={() => setHistoryFilter('AVATAR')}>数字人视频</button><button type="button" onClick={() => void refresh()}>刷新</button></div></div>{history.length === 0 ? <p className="muted">暂无生成记录，先在上方输入文案开始工作。</p> : <div className="revision-list">{history.map(({ kind, item }) => <article className="compact-card" key={`${kind}-${item.id}`}><div className="section-title"><strong>{kind === 'speech' ? 'TTS 2.5 配音' : '数字人视频'}</strong><span>{label(item.status)}</span></div><p className="muted">{'text' in item ? item.text : `配音素材：${item.speechAssetId}`}</p>{item.error?.message && <p className="form-error">{item.error.message}</p>}{'outputAssetId' in item && item.outputAssetId && kind === 'speech' && <audio controls preload="none" src={`/api/v1/projects/${item.projectId}/assets/${item.outputAssetId}/content`} />}{'outputAssetId' in item && item.outputAssetId && kind === 'avatar' && <video controls preload="metadata" src={`/api/v1/projects/${item.projectId}/assets/${item.outputAssetId}/content`} />}{kind === 'speech' && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(item.status) && <button type="button" disabled={busy} onClick={() => void cancelSpeech(item)}>取消任务</button>}{kind === 'speech' && (item.status === 'FAILED' || item.status === 'CANCELLED') && <button type="button" disabled={busy} onClick={() => void retrySpeech(item)}>重新提交</button>}{kind === 'speech' && item.outputAssetId && <button type="button" onClick={() => setSpeechAssetId(item.outputAssetId || '')}>用于数字人</button>}</article>)}</div>}</section>
    </>}
  </main>;
}
