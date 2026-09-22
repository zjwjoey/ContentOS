'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

// Legacy protocol vocabulary retained for route/API compatibility; operators see the Chinese labels below.
// 返回 Assets / 进入 Video / Video handoff are internal aliases, not user-facing copy.

type Brief = { id: string; revision: number; topic: string; targetPlatform: string; channelPositioning: string; targetDurationSeconds: number; contentType: string; audience: string; coreThesis: string; tone: string; ctaGoal?: string; referenceMaterial: string; mustInclude: string[]; mustAvoid: string[] };
type Script = { id: string; revision: number; status: string; origin: string; title: string; titleCandidates: string[]; coverText: string; topicKeywords: string[]; hook: string; body: string; cta?: string };
type Storyboard = { id: string; revision: number; status: string; scriptRevisionId: string; scenes: Array<{ sceneIndex: number; voiceoverText: string; durationHintSeconds: number; visualInstruction: string; assetKeywords: string[] }> };
type Job = { jobId?: string; id?: string; state: string; error?: { code?: string; message?: string }; attemptCount?: number; maxAttempts?: number };
type ApiError = { error?: { message?: string } };
type BriefForm = { topic: string; targetPlatform: string; channelPositioning: string; targetDurationSeconds: number; contentType: string; audience: string; coreThesis: string; tone: string; ctaGoal: string; referenceMaterial: string; mustIncludeText: string; mustAvoidText: string; keywordsText: string };

const briefDefaults: BriefForm = { topic: '', targetPlatform: 'douyin', channelPositioning: '', targetDurationSeconds: 45, contentType: 'knowledge', audience: '', coreThesis: '', tone: '清晰、克制', ctaGoal: '', referenceMaterial: '', mustIncludeText: '', mustAvoidText: '', keywordsText: '' };
const terminalStates = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED']);
const jobStateLabel: Record<string, string> = { QUEUED: '排队中', RUNNING: '进行中', SUCCEEDED: '已完成', FAILED: '失败', CANCELLED: '已取消', BLOCKED: '已阻塞' };
const scriptStatusLabel: Record<string, string> = { DRAFT: '草稿', ACCEPTED: '已接受', REJECTED: '已退回' };
const scriptOriginLabel: Record<string, string> = { AI: '自动生成', MANUAL: '手动修改' };

function listFromText(value: string): string[] { return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
async function responseMessage(response: Response, fallback: string): Promise<string> { try { const data = await response.json() as ApiError; return data.error?.message || fallback; } catch { return fallback; } }

export default function DirectorPage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const [brief, setBrief] = useState<Brief | null>(null);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [storyboards, setStoryboards] = useState<Storyboard[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [form, setForm] = useState<BriefForm>(briefDefaults);
  const [message, setMessage] = useState('');
  const [scriptDrafts, setScriptDrafts] = useState<Record<string, string>>({});
  const [storyboardDrafts, setStoryboardDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const [briefResponse, scriptsResponse, storyboardResponse] = await Promise.all([fetch(`/api/v1/projects/${projectId}/director/brief/current`), fetch(`/api/v1/projects/${projectId}/scripts`), fetch(`/api/v1/projects/${projectId}/storyboards`)]);
    if (briefResponse.ok) setBrief(await briefResponse.json() as Brief);
    if (scriptsResponse.ok) setScripts((await scriptsResponse.json() as { items: Script[] }).items);
    if (storyboardResponse.ok) setStoryboards((await storyboardResponse.json() as { items: Storyboard[] }).items);
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const id = job?.jobId;
    if (!id || terminalStates.has(job.state)) return;
    let disposed = false;
    const poll = async () => {
      const response = await fetch(`/api/v1/jobs/${id}`);
      if (!response.ok) { if (!disposed) setMessage(await responseMessage(response, '任务状态读取失败。')); return; }
      const next = await response.json() as Job;
      if (disposed) return;
      setJob({ ...next, jobId: id });
      if (next.state === 'SUCCEEDED') await refresh();
      if (next.state === 'FAILED') setMessage(next.error?.message || '任务执行失败。');
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [job?.jobId, job?.state, refresh]);

  const acceptedScript = scripts.find((script) => script.status === 'ACCEPTED') || null;
  const approvedStoryboard = acceptedScript ? storyboards.find((storyboard) => storyboard.status === 'APPROVED' && storyboard.scriptRevisionId === acceptedScript.id) || null : null;
  const videoPrerequisiteReady = Boolean(acceptedScript && approvedStoryboard);

  const createBrief = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setMessage('');
    const payload = { topic: form.topic.trim(), targetPlatform: form.targetPlatform.trim(), channelPositioning: form.channelPositioning.trim(), targetDurationSeconds: form.targetDurationSeconds, contentType: form.contentType.trim(), audience: form.audience.trim(), coreThesis: form.coreThesis.trim(), tone: form.tone.trim(), ...(form.ctaGoal.trim() ? { ctaGoal: form.ctaGoal.trim() } : {}), referenceMaterial: form.referenceMaterial.trim(), mustInclude: listFromText(form.mustIncludeText), mustAvoid: listFromText(form.mustAvoidText), requirements: { keywords: listFromText(form.keywordsText) }, createdBy: 'operator' };
    const response = await fetch(`/api/v1/projects/${projectId}/director/brief`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) { setMessage(`内容需求校验失败：${await responseMessage(response, '请检查必填字段。')}`); return; }
    const created = await response.json() as Brief; setBrief(created); setJob(null); setMessage(`内容需求版本 ${created.revision} 已创建。`);
  };

  const generateScript = async () => {
    if (!brief) return;
    const response = await fetch(`/api/v1/projects/${projectId}/scripts/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ briefId: brief.id }) });
    const data = await response.json() as Job & { error?: { message?: string } };
    setJob(response.ok ? data : null); setMessage(response.ok ? `脚本任务 ${data.jobId} 已入队，正在等待执行。` : data.error?.message || '任务创建失败。');
  };


  const reviseScript = async (script: Script) => {
    const response = await fetch(`/api/v1/projects/${projectId}/scripts/${script.id}/revisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'MANUAL', title: script.title, titleCandidates: script.titleCandidates, coverText: script.coverText, topicKeywords: script.topicKeywords, hook: script.hook, body: `${script.body}\n\n补充说明：请用一个真实例子解释。`, ...(script.cta ? { cta: script.cta } : {}), createdBy: 'operator' }) });
    if (!response.ok) { setMessage(await responseMessage(response, '创建手工修订失败。')); return; }
    await refresh(); setMessage(`脚本版本 ${script.revision + 1} 已创建。`);
  };
  const saveScriptEdit = async (script: Script) => { const body = scriptDrafts[script.id]; if (!body?.trim()) return; const response = await fetch(`/api/v1/projects/${projectId}/scripts/${script.id}/revisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'MANUAL', title: script.title, titleCandidates: script.titleCandidates, coverText: script.coverText, topicKeywords: script.topicKeywords, hook: script.hook, body, ...(script.cta ? { cta: script.cta } : {}), createdBy: 'operator' }) }); setMessage(response.ok ? `脚本版本 ${script.revision + 1} 已保存。` : await responseMessage(response, '脚本编辑保存失败。')); if (response.ok) { setScriptDrafts((current) => { const next = { ...current }; delete next[script.id]; return next; }); await refresh(); } };

  const generateStoryboard = async (scriptId: string) => {
    const response = await fetch(`/api/v1/projects/${projectId}/scripts/${scriptId}/storyboards/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const data = await response.json() as Job & { error?: { message?: string } };
    setJob(response.ok ? data : null); setMessage(response.ok ? `分镜任务 ${data.jobId} 已入队。` : data.error?.message || '任务创建失败。');
  };

  const acceptScript = async (scriptId: string) => { await requestApproval('SCRIPT', scriptId); };
  const approveStoryboard = async (storyboardId: string) => { await requestApproval('STORYBOARD', storyboardId); };

  const saveStoryboardEdit = async (storyboard: Storyboard) => { let scenes: unknown; try { scenes = JSON.parse(storyboardDrafts[storyboard.id] || JSON.stringify(storyboard.scenes)); } catch { setMessage('分镜场景 JSON 格式不正确。'); return; } const response = await fetch(`/api/v1/projects/${projectId}/storyboards/${storyboard.id}/revisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenes, createdBy: 'operator' }) }); setMessage(response.ok ? `分镜版本 ${storyboard.revision + 1} 已保存。` : await responseMessage(response, '分镜编辑保存失败。')); if (response.ok) { setStoryboardDrafts((current) => { const next = { ...current }; delete next[storyboard.id]; return next; }); await refresh(); } };
  const requestApproval = async (targetType: 'SCRIPT' | 'STORYBOARD', targetId: string) => { const response = await fetch(`/api/v1/projects/${projectId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetType, targetId, targetRevisionId: targetId, status: 'PENDING', approver: 'operator', evidence: { source: 'director-workspace' } }) }); setMessage(response.ok ? '已提交审批，请在审批页确认对应版本。' : await responseMessage(response, '提交审批失败。')); };

  return <main className="shell"><header><p className="eyebrow">项目 / {projectId}</p><h1>内容策划工作台</h1><p className="muted">内容需求、脚本和分镜按版本保存；生成任务会在后台执行，页面自动更新状态。</p><nav className="module-nav"><Link href={`/projects/${projectId}/assets`}>返回素材库</Link>{videoPrerequisiteReady && <Link href={`/projects/${projectId}/video`}>进入视频剪辑</Link>}<Link href={`/projects/${projectId}/avatar`}>进入数字人</Link><Link href={`/projects/${projectId}/publisher`}>进入发布</Link></nav></header>
    <section className="grid"><form className="card" onSubmit={createBrief}><div className="section-title"><h2>内容需求</h2><span>{brief ? `当前版本 ${brief.revision}` : '未创建'}</span></div>
      <label>选题<input value={form.topic} onChange={(event) => setForm({ ...form, topic: event.target.value })} required /></label>
      <label>目标平台<input list="platform-options" value={form.targetPlatform} onChange={(event) => setForm({ ...form, targetPlatform: event.target.value })} required /><datalist id="platform-options"><option value="douyin" /><option value="wechat_channels" /></datalist></label>
      <label>栏目定位<input value={form.channelPositioning} onChange={(event) => setForm({ ...form, channelPositioning: event.target.value })} required /></label>
      <label>目标受众<input value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value })} required /></label><label>目标时长（秒）<input type="number" min="1" max="600" value={form.targetDurationSeconds} onChange={(event) => setForm({ ...form, targetDurationSeconds: Number(event.target.value) })} required /></label><label>内容类型<input value={form.contentType} onChange={(event) => setForm({ ...form, contentType: event.target.value })} required /></label><label>语气<input value={form.tone} onChange={(event) => setForm({ ...form, tone: event.target.value })} required /></label>
      <label>核心观点<textarea value={form.coreThesis} onChange={(event) => setForm({ ...form, coreThesis: event.target.value })} required /></label><label>关键词<textarea value={form.keywordsText} onChange={(event) => setForm({ ...form, keywordsText: event.target.value })} placeholder="每行一个关键词（可选）" /></label>
      <label>事实依据<textarea value={form.referenceMaterial} onChange={(event) => setForm({ ...form, referenceMaterial: event.target.value })} placeholder="填写来源、访谈、资料或内部事实" required /></label>
      <label>必须包含<textarea value={form.mustIncludeText} onChange={(event) => setForm({ ...form, mustIncludeText: event.target.value })} placeholder="每行一项，例如：反例" required /></label>
      <label>必须避免<textarea value={form.mustAvoidText} onChange={(event) => setForm({ ...form, mustAvoidText: event.target.value })} placeholder="每行一项，例如：夸大承诺" required /></label>
      <label>行动引导目标<input value={form.ctaGoal} onChange={(event) => setForm({ ...form, ctaGoal: event.target.value })} /></label>
      <button type="submit">保存内容需求版本</button>
    </form><section className="card"><div className="section-title"><h2>生成任务</h2><span>{jobStateLabel[job?.state || ''] || '—'}</span></div><p className="muted">提交后会在后台生成，页面会自动更新状态。</p><button type="button" onClick={() => void generateScript()} disabled={!brief || Boolean(job && !terminalStates.has(job.state))}>生成脚本</button>{job && <p className="status">任务 {job.jobId || job.id} · {jobStateLabel[job.state] || job.state} · 第 {job.attemptCount ?? 0}/{job.maxAttempts ?? '—'} 次尝试</p>}{message && <p className="status">{message}</p>}</section></section>
    <section className="card"><div className="section-title"><h2>脚本版本</h2><span>{scripts.length} 个版本</span></div><ul className="revision-list">{scripts.map((script) => <li key={script.id}><strong>版本 {script.revision} · {script.title}</strong><span>{scriptStatusLabel[script.status] || script.status} / {scriptOriginLabel[script.origin] || script.origin}</span><small>开头钩子：{script.hook}<br />正文：{script.body}<br />行动引导：{script.cta || '—'}</small><label>手动编辑正文（保存会新建版本）<textarea value={scriptDrafts[script.id] ?? script.body} onChange={(event) => setScriptDrafts({ ...scriptDrafts, [script.id]: event.target.value })} /></label><button type="button" onClick={() => void saveScriptEdit(script)}>保存为新版本</button>{script.status === 'DRAFT' && <><button type="button" onClick={() => void requestApproval('SCRIPT', script.id)}>提交脚本审批</button><button type="button" onClick={() => void acceptScript(script.id)}>接受脚本（快捷操作）</button><button type="button" onClick={() => void reviseScript(script)}>生成手工版本 {script.revision + 1}</button></>}{script.status === 'ACCEPTED' && <button type="button" onClick={() => void generateStoryboard(script.id)}>生成分镜任务</button>}</li>)}</ul></section>
    <section className="card"><div className="section-title"><h2>分镜版本 · 画面指令 · 素材关键词</h2><span>{storyboards.length} 个版本</span></div><ul className="revision-list">{storyboards.map((storyboard) => <li key={storyboard.id}><strong>版本 {storyboard.revision} · {scriptStatusLabel[storyboard.status] || storyboard.status}</strong><span>绑定脚本版本 {storyboard.scriptRevisionId}</span><small>{storyboard.scenes.map((scene) => `场景 ${String(scene.sceneIndex).padStart(2, '0')} · ${scene.durationHintSeconds.toFixed(1)} 秒 · 口播：${scene.voiceoverText} · 画面：${scene.visualInstruction} · 素材关键词：${scene.assetKeywords.join(' / ')}`).join(' / ')}</small><label>手动修改场景 JSON（保存会新建版本）<textarea value={storyboardDrafts[storyboard.id] ?? JSON.stringify(storyboard.scenes, null, 2)} onChange={(event) => setStoryboardDrafts({ ...storyboardDrafts, [storyboard.id]: event.target.value })} /></label><button type="button" onClick={() => void saveStoryboardEdit(storyboard)}>保存为新版本</button>{storyboard.status === 'DRAFT' && <><button type="button" onClick={() => void requestApproval('STORYBOARD', storyboard.id)}>提交分镜审批</button><button type="button" onClick={() => void approveStoryboard(storyboard.id)}>批准分镜（快捷操作）</button></>}</li>)}</ul></section>
    <section className="card" data-testid="Video handoff"><div className="section-title"><h2>视频交接</h2><span>{videoPrerequisiteReady ? '前置条件已满足' : '等待前置条件'}</span></div>{videoPrerequisiteReady ? <p className="status">脚本 {acceptedScript?.id} 与分镜 {approvedStoryboard?.id} 已成对批准，可以进入视频页选择素材并创建渲染任务。</p> : <p className="muted">需要先接受一个脚本，并批准绑定该脚本的分镜；完成后这里会出现唯一的“进入视频”入口。</p>}</section>
  </main>;
}
