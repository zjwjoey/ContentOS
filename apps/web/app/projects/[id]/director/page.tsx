'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Brief = { id: string; revision: number; topic: string; targetPlatform: string; channelPositioning: string; targetDurationSeconds: number; contentType: string; audience: string; coreThesis: string; tone: string; ctaGoal?: string; referenceMaterial: string; mustInclude: string[]; mustAvoid: string[] };
type Script = { id: string; revision: number; status: string; origin: string; title: string; titleCandidates: string[]; coverText: string; topicKeywords: string[]; hook: string; body: string; cta?: string };
type Storyboard = { id: string; revision: number; status: string; scriptRevisionId: string; scenes: Array<{ sceneIndex: number; voiceoverText: string; durationHintSeconds: number; visualInstruction: string; assetKeywords: string[] }> };
type Job = { jobId?: string; id?: string; state: string; error?: { code?: string; message?: string }; attemptCount?: number; maxAttempts?: number };
type ApiError = { error?: { message?: string } };
type BriefForm = { topic: string; targetPlatform: string; channelPositioning: string; targetDurationSeconds: number; contentType: string; audience: string; coreThesis: string; tone: string; ctaGoal: string; referenceMaterial: string; mustIncludeText: string; mustAvoidText: string };

const briefDefaults: BriefForm = { topic: '', targetPlatform: 'douyin', channelPositioning: '', targetDurationSeconds: 45, contentType: 'knowledge', audience: '', coreThesis: '', tone: '清晰、克制', ctaGoal: '', referenceMaterial: '', mustIncludeText: '', mustAvoidText: '' };
const terminalStates = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED']);

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
      if (!response.ok) { if (!disposed) setMessage(await responseMessage(response, 'Job 状态读取失败。')); return; }
      const next = await response.json() as Job;
      if (disposed) return;
      setJob({ ...next, jobId: id });
      if (next.state === 'SUCCEEDED') await refresh();
      if (next.state === 'FAILED') setMessage(next.error?.message || 'Job 执行失败。');
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
    const payload = { topic: form.topic.trim(), targetPlatform: form.targetPlatform.trim(), channelPositioning: form.channelPositioning.trim(), targetDurationSeconds: form.targetDurationSeconds, contentType: form.contentType.trim(), audience: form.audience.trim(), coreThesis: form.coreThesis.trim(), tone: form.tone.trim(), ...(form.ctaGoal.trim() ? { ctaGoal: form.ctaGoal.trim() } : {}), referenceMaterial: form.referenceMaterial.trim(), mustInclude: listFromText(form.mustIncludeText), mustAvoid: listFromText(form.mustAvoidText), requirements: {}, createdBy: 'operator' };
    const response = await fetch(`/api/v1/projects/${projectId}/director/brief`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) { setMessage(`Brief 校验失败：${await responseMessage(response, '请检查必填字段。')}`); return; }
    const created = await response.json() as Brief; setBrief(created); setJob(null); setMessage(`Brief V${created.revision} 已创建。`);
  };

  const generateScript = async () => {
    if (!brief) return;
    const response = await fetch(`/api/v1/projects/${projectId}/scripts/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ briefId: brief.id }) });
    const data = await response.json() as Job & { error?: { message?: string } };
    setJob(response.ok ? data : null); setMessage(response.ok ? `Script Job ${data.jobId} 已入队，正在等待 Worker。` : data.error?.message || 'Job 创建失败。');
  };

  const acceptScript = async (scriptId: string) => {
    const response = await fetch(`/api/v1/projects/${projectId}/scripts/${scriptId}/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!response.ok) { setMessage(await responseMessage(response, '接受 Script 失败。')); return; }
    await refresh(); setMessage('Script 已接受。');
  };

  const reviseScript = async (script: Script) => {
    const response = await fetch(`/api/v1/projects/${projectId}/scripts/${script.id}/revisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'MANUAL', title: script.title, titleCandidates: script.titleCandidates, coverText: script.coverText, topicKeywords: script.topicKeywords, hook: script.hook, body: `${script.body}\n\n补充说明：请用一个真实例子解释。`, ...(script.cta ? { cta: script.cta } : {}), createdBy: 'operator' }) });
    if (!response.ok) { setMessage(await responseMessage(response, '创建手工修订失败。')); return; }
    await refresh(); setMessage(`Script V${script.revision + 1} 已创建。`);
  };

  const generateStoryboard = async (scriptId: string) => {
    const response = await fetch(`/api/v1/projects/${projectId}/scripts/${scriptId}/storyboards/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const data = await response.json() as Job & { error?: { message?: string } };
    setJob(response.ok ? data : null); setMessage(response.ok ? `Storyboard Job ${data.jobId} 已入队。` : data.error?.message || 'Job 创建失败。');
  };

  const approveStoryboard = async (storyboardId: string) => {
    const response = await fetch(`/api/v1/projects/${projectId}/storyboards/${storyboardId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!response.ok) { setMessage(await responseMessage(response, '批准 Storyboard 失败。')); return; }
    await refresh(); setMessage('Storyboard 已批准。');
  };

  return <main className="shell"><header><p className="eyebrow">Project / {projectId}</p><h1>Director 工作台</h1><p className="muted">Brief 是输入事实，Script 和 Storyboard 以追加版本保存；生成工作通过 Durable Job 执行。</p><nav className="module-nav"><Link href={`/projects/${projectId}/assets`}>返回 Assets</Link>{videoPrerequisiteReady && <Link href={`/projects/${projectId}/video`}>进入 Video</Link>}<Link href={`/projects/${projectId}/publisher`}>进入 Publisher</Link></nav></header>
    <section className="grid"><form className="card" onSubmit={createBrief}><div className="section-title"><h2>ContentBrief</h2><span>{brief ? `当前 V${brief.revision}` : '未创建'}</span></div>
      <label>选题<input value={form.topic} onChange={(event) => setForm({ ...form, topic: event.target.value })} required /></label>
      <label>目标平台<input list="platform-options" value={form.targetPlatform} onChange={(event) => setForm({ ...form, targetPlatform: event.target.value })} required /><datalist id="platform-options"><option value="douyin" /><option value="wechat_channels" /></datalist></label>
      <label>栏目定位<input value={form.channelPositioning} onChange={(event) => setForm({ ...form, channelPositioning: event.target.value })} required /></label>
      <label>目标受众<input value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value })} required /></label>
      <label>核心观点<textarea value={form.coreThesis} onChange={(event) => setForm({ ...form, coreThesis: event.target.value })} required /></label>
      <label>事实依据<textarea value={form.referenceMaterial} onChange={(event) => setForm({ ...form, referenceMaterial: event.target.value })} placeholder="填写来源、访谈、资料或内部事实" required /></label>
      <label>必须包含<textarea value={form.mustIncludeText} onChange={(event) => setForm({ ...form, mustIncludeText: event.target.value })} placeholder="每行一项，例如：反例" required /></label>
      <label>必须避免<textarea value={form.mustAvoidText} onChange={(event) => setForm({ ...form, mustAvoidText: event.target.value })} placeholder="每行一项，例如：夸大承诺" required /></label>
      <label>CTA 目标<input value={form.ctaGoal} onChange={(event) => setForm({ ...form, ctaGoal: event.target.value })} /></label>
      <button type="submit">保存 Brief 版本</button>
    </form><section className="card"><div className="section-title"><h2>生成 Job</h2><span>{job?.state || '—'}</span></div><p className="muted">API 只入队，Worker 执行 Fake AI；页面会自动读取状态。</p><button type="button" onClick={() => void generateScript()} disabled={!brief || Boolean(job && !terminalStates.has(job.state))}>生成 Script</button>{job && <p className="status">{job.jobId || job.id} · {job.state} · 尝试 {job.attemptCount ?? 0}/{job.maxAttempts ?? '—'}</p>}{message && <p className="status">{message}</p>}</section></section>
    <section className="card"><div className="section-title"><h2>Script revisions</h2><span>{scripts.length} 个版本</span></div><ul className="revision-list">{scripts.map((script) => <li key={script.id}><strong>V{script.revision} · {script.title}</strong><span>{script.status} / {script.origin}</span><small>Hook：{script.hook}<br />Body：{script.body}<br />CTA：{script.cta || '—'}</small>{script.status === 'DRAFT' && <><button type="button" onClick={() => void acceptScript(script.id)}>接受 Script</button><button type="button" onClick={() => void reviseScript(script)}>生成手工 V{script.revision + 1}</button></>}{script.status === 'ACCEPTED' && <button type="button" onClick={() => void generateStoryboard(script.id)}>生成 Storyboard Job</button>}</li>)}</ul></section>
    <section className="card"><div className="section-title"><h2>Storyboard revisions · Visual Instruction · 素材关键词</h2><span>{storyboards.length} 个版本</span></div><ul className="revision-list">{storyboards.map((storyboard) => <li key={storyboard.id}><strong>V{storyboard.revision} · {storyboard.status}</strong><span>绑定 Script {storyboard.scriptRevisionId}</span><small>{storyboard.scenes.map((scene) => `Scene ${String(scene.sceneIndex).padStart(2, '0')} · ${scene.durationHintSeconds.toFixed(1)} 秒 · 口播：${scene.voiceoverText} · 画面：${scene.visualInstruction} · 素材关键词：${scene.assetKeywords.join(' / ')}`).join(' / ')}</small>{storyboard.status === 'DRAFT' && <button type="button" onClick={() => void approveStoryboard(storyboard.id)}>批准 Storyboard</button>}</li>)}</ul></section>
    <section className="card"><div className="section-title"><h2>Video handoff</h2><span>{videoPrerequisiteReady ? '前置条件已满足' : '等待前置条件'}</span></div>{videoPrerequisiteReady ? <p className="status">Script {acceptedScript?.id} 与 Storyboard {approvedStoryboard?.id} 已成对批准，可以进入 Video 选择素材并创建渲染 Job。</p> : <p className="muted">需要先接受一个 Script，并批准绑定该 Script 的 Storyboard；完成后这里会出现唯一的“进入 Video”入口。</p>}</section>
  </main>;
}
