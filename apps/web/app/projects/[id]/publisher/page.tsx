'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Account = { id: string; platformId: string; displayName: string; status: string };
type FakeOutcome = 'SUCCESS' | 'AUTH_EXPIRED' | 'VERIFICATION' | 'DOM_DRIFT' | 'BROWSER_CRASH' | 'UNKNOWN_SIDE_EFFECT' | 'UNKNOWN_NO_SIDE_EFFECT' | 'RATE_LIMIT' | 'NETWORK';
type PublishRequest = { id: string; accountId: string; status: string; failureMessage: string | null; createdAt: string };
type Asset = { id: string; checksum: string; kind: 'VIDEO_RENDER'; lifecycle: 'READY'; byteSize: number };
type RequestAggregate = { request: PublishRequest; revision: { id: string; title: string; description: string; assetId: string }; attempts: Array<{ id: string; attemptNumber: number; status: string; failureCode?: string | null; failureClassification?: string | null; finishedAt?: string | null }>; externalPosts: Array<{ id: string; externalPostId: string; externalUrl: string | null }>; nextAction: 'NEEDS_HUMAN_ACTION' | null; approval?: { status: 'PENDING' | 'APPROVED' | 'REJECTED'; targetRevisionId: string } };
type ProjectPublishSummary = { accountCount: number; requestCount: number; confirmedExternalPostCount: number; needsHumanActionCount: number; statusCounts: Record<string, number> };
type Preflight = { realAdaptersEnabled: boolean; publishMode: string; checks: { adapterRuntime: string; credentials: boolean; accountReady: boolean; humanActionRequired: boolean } };
type ApiError = { error?: { message?: string } };
const fakeOutcomeOptions: Array<{ value: FakeOutcome; label: string }> = [
  { value: 'SUCCESS', label: '成功' }, { value: 'NETWORK', label: '网络故障（可重试）' }, { value: 'AUTH_EXPIRED', label: '登录失效（人工处理）' }, { value: 'VERIFICATION', label: '需要验证（人工处理）' }, { value: 'BROWSER_CRASH', label: '浏览器崩溃（未知状态）' }, { value: 'UNKNOWN_SIDE_EFFECT', label: '未知状态（可能已发布）' }, { value: 'UNKNOWN_NO_SIDE_EFFECT', label: '未知状态（未确认发布）' }, { value: 'RATE_LIMIT', label: '频率限制（可重试）' }, { value: 'DOM_DRIFT', label: '平台结构变化（失败）' },
];

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try { return ((await response.json()) as ApiError).error?.message || fallback; }
  catch { return fallback; }
}

export default function PublisherPage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [requests, setRequests] = useState<RequestAggregate[]>([]);
  const [summary, setSummary] = useState<ProjectPublishSummary | null>(null);
  const [displayName, setDisplayName] = useState('Fake Platform 测试账号');
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [assetId, setAssetId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [fakeOutcomes, setFakeOutcomes] = useState<Record<string, FakeOutcome>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [realAdaptersEnabled, setRealAdaptersEnabled] = useState(false);
  const [preflight, setPreflight] = useState<Preflight | null>(null);

  const refresh = useCallback(async () => {
    const [accountResponse, assetResponse, requestResponse, summaryResponse, approvalResponse, runtimeResponse, preflightResponse] = await Promise.all([
      fetch(`/api/v1/projects/${projectId}/publisher/accounts`),
      fetch(`/api/v1/projects/${projectId}/publisher/assets`),
      fetch(`/api/v1/projects/${projectId}/publisher/requests`),
      fetch(`/api/v1/projects/${projectId}/publisher/summary`),
      fetch(`/api/v1/projects/${projectId}/approvals`),
      fetch('/api/v1/runtime/status'),
      fetch(`/api/v1/projects/${projectId}/publisher/preflight`),
    ]);
    if (accountResponse.ok) {
      const nextAccounts = ((await accountResponse.json()) as { items: Account[] }).items;
      setAccounts(nextAccounts);
      setSelectedAccountIds((current) => current.length ? current.filter((id) => nextAccounts.some((account) => account.id === id)) : nextAccounts[0]?.id ? [nextAccounts[0].id] : []);
      const simulated = await Promise.all(nextAccounts.filter((account) => account.platformId === 'fake-platform').map(async (account) => {
        const response = await fetch(`/api/v1/projects/${projectId}/publisher/accounts/${account.id}/fake-outcome`);
        return response.ok ? [account.id, (await response.json() as { outcome: FakeOutcome }).outcome] as const : null;
      }));
      setFakeOutcomes(Object.fromEntries(simulated.filter((item): item is readonly [string, FakeOutcome] => item !== null)));
    }
    if (assetResponse.ok) {
      const nextAssets = ((await assetResponse.json()) as { items: Asset[] }).items;
      setAssets(nextAssets);
      setAssetId((current) => current || nextAssets[0]?.id || '');
    }
    if (requestResponse.ok) {
      const items = ((await requestResponse.json()) as { items: PublishRequest[] }).items;
      const approvalItems = approvalResponse.ok ? ((await approvalResponse.json()) as { items: Array<{ targetType: string; targetId: string; targetRevisionId: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' }> }).items : [];
      const aggregates = await Promise.all(items.map(async (item) => {
        const response = await fetch(`/api/v1/projects/${projectId}/publisher/requests/${item.id}`);
        if (!response.ok) return { request: item, revision: { id: '', title: item.id, description: '', assetId: '' }, attempts: [], externalPosts: [], nextAction: null };
        const aggregate = await response.json() as RequestAggregate;
        const approval = approvalItems.find((candidate) => candidate.targetType === 'PUBLISH' && candidate.targetId === item.id && candidate.targetRevisionId === aggregate.revision.id);
        return approval ? { ...aggregate, approval: { status: approval.status, targetRevisionId: approval.targetRevisionId } } : aggregate;
      }));
      setRequests(aggregates);
    }
    if (summaryResponse.ok) setSummary(await summaryResponse.json() as ProjectPublishSummary);
    if (runtimeResponse.ok) setRealAdaptersEnabled(((await runtimeResponse.json()) as { publisher: { realAdaptersEnabled: boolean } }).publisher.realAdaptersEnabled);
    if (preflightResponse.ok) setPreflight(await preflightResponse.json() as Preflight);
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);
  const hasActivePublisherWork = requests.some(({ request, attempts, nextAction }) => {
    if (['QUEUED', 'PUBLISHING', 'RECONCILING'].includes(request.status)) return true;
    const latestAttempt = attempts[attempts.length - 1];
    return request.status === 'FAILED' && nextAction !== 'NEEDS_HUMAN_ACTION' && latestAttempt?.failureClassification === 'RETRYABLE';
  });
  useEffect(() => {
    if (!hasActivePublisherWork) return;
    const interval = window.setInterval(() => void refresh(), 500);
    return () => window.clearInterval(interval);
  }, [hasActivePublisherWork, refresh]);

  const createFakeAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setMessage('');
    const response = await fetch(`/api/v1/projects/${projectId}/publisher/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platformId: 'fake-platform', displayName: displayName.trim(), status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false } }) });
    setMessage(response.ok ? 'Fake Platform 账号已创建。' : await responseMessage(response, '账号创建失败。'));
    if (response.ok) await refresh();
    setBusy(false);
  };

  const setFakeOutcome = async (accountId: string, outcome: FakeOutcome) => {
    setBusy(true); setMessage('');
    const response = await fetch(`/api/v1/projects/${projectId}/publisher/accounts/${accountId}/fake-outcome`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome }) });
    if (!response.ok) setMessage(await responseMessage(response, '开发模拟结果更新失败。'));
    else { setFakeOutcomes((current) => ({ ...current, [accountId]: outcome })); setMessage('开发模拟结果已更新，仅影响 Fake Platform。'); }
    setBusy(false);
  };

  const createRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setMessage('');
    const asset = assets.find((item) => item.id === assetId);
    if (!asset) { setMessage('请选择当前项目的可发布成片。'); setBusy(false); return; }
    if (!selectedAccountIds.length) { setMessage('至少选择一个发布账号。'); setBusy(false); return; }
    const response = await fetch(`/api/v1/projects/${projectId}/publisher/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountIds: selectedAccountIds, assetId: asset.id, title: title.trim(), description: description.trim(), desiredPublishAt: null, createdBy: 'operator', idempotencyKey: `operator-${projectId}-${assetId}-${title.trim()}`, correlationId: `operator-${projectId}` }) });
    setMessage(response.ok ? '项目发布交接已创建，等待各账号的 Approval Gate。' : await responseMessage(response, '项目发布交接失败。'));
    if (response.ok) await refresh();
    setBusy(false);
  };

  const queueRequest = async (requestId: string) => {
    setBusy(true); setMessage('');
    const current = requests.find((item) => item.request.id === requestId);
    if (!current?.revision.id) { setMessage('发布 Revision 信息缺失。'); setBusy(false); return; }
    if (current.approval?.status !== 'APPROVED' || current.approval.targetRevisionId !== current.revision.id) { setMessage('必须先在 Approval Gate 批准当前发布 Revision。'); setBusy(false); return; }
    const queued = await fetch(`/api/v1/projects/${projectId}/publisher/requests/${requestId}/queue`, { method: 'POST' });
    setMessage(queued.ok ? '已批准的发布 Revision 已进入 PUBLISH Job 队列。' : await responseMessage(queued, '发布入队失败。'));
    if (queued.ok) await refresh();
    setBusy(false);
  };

  return <main className="shell">
    <header><p className="eyebrow">Project / {projectId}</p><h1>Publisher 工作台</h1><p className="muted">当前只连接 Fake Platform，用于验证项目交接、Approval Gate、入队、Worker 执行和发布记录。</p>{!realAdaptersEnabled && <p className="status">真实平台发布未启用（PUBLISHER_REAL_ADAPTERS_ENABLED=false）</p>}<nav className="module-nav"><Link href={`/projects/${projectId}/director`}>Director</Link><Link href={`/projects/${projectId}/approvals`}>Approval Gate</Link></nav></header>
    {summary && <section className="card"><div className="section-title"><h2>项目发布摘要</h2><span>{summary.requestCount} 条请求</span></div><p className="muted">账号 {summary.accountCount} 个 · 已确认外部内容 {summary.confirmedExternalPostCount} 条 · 待人工处理 {summary.needsHumanActionCount} 条 · 已发布 {summary.statusCounts.PUBLISHED || 0} 条</p>{preflight && <p className="muted">发布预检：{preflight.publishMode} · Adapter {preflight.checks.adapterRuntime} · 账号就绪 {preflight.checks.accountReady ? '是' : '否'} · 凭据引用 {preflight.checks.credentials ? '完整' : '需处理'}{preflight.checks.humanActionRequired ? ' · 需要人工处理' : ''}</p>}</section>}
    <section className="grid">
      <form className="card" onSubmit={createFakeAccount}><div className="section-title"><h2>Fake Platform 账号</h2><span>{accounts.length} 个</span></div><label>显示名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label><button disabled={busy}>创建测试账号</button><ul className="revision-list">{accounts.map((account) => <li key={account.id}><strong>{account.displayName}</strong><span>{account.platformId} · {account.status}</span>{account.platformId === 'fake-platform' && fakeOutcomes[account.id] && <label>开发模拟结果<select value={fakeOutcomes[account.id]} disabled={busy} onChange={(event) => void setFakeOutcome(account.id, event.target.value as FakeOutcome)}>{fakeOutcomeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}</li>)}</ul></form>
      <form className="card" onSubmit={createRequest}><div className="section-title"><h2>项目发布交接</h2><span>{selectedAccountIds.length} 个账号</span></div><fieldset><legend>目标账号</legend>{accounts.map((account) => <label key={account.id}><input type="checkbox" checked={selectedAccountIds.includes(account.id)} onChange={(event) => setSelectedAccountIds((current) => event.target.checked ? [...current, account.id] : current.filter((id) => id !== account.id))} />{account.displayName} · {account.platformId} · {account.status}</label>)}</fieldset><label>成片 Render Asset<select value={assetId} onChange={(event) => setAssetId(event.target.value)} required><option value="">请选择可发布成片</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.kind} · {asset.byteSize} bytes</option>)}</select></label><label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} /></label><label>描述<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label><button disabled={busy || !selectedAccountIds.length || !assetId}>创建项目发布草稿</button></form>
    </section>
    <section className="card"><div className="section-title"><h2>发布请求</h2><span>{requests.length} 条</span></div>{message && <p className="status">{message}</p>}<ul className="revision-list">{requests.map(({ request, revision, attempts, externalPosts, nextAction, approval }) => <li key={request.id}><strong>{revision.title}</strong><span>{request.status} · Asset {revision.assetId} · Revision {revision.id}</span><small>Approval：{approval?.status || '未创建'}{approval && ` · ${approval.targetRevisionId}`}</small>{attempts.map((attempt) => <small key={attempt.id}>PublishAttempt #{attempt.attemptNumber} · {attempt.status}{attempt.failureCode ? ` · ${attempt.failureCode}` : ''}</small>)}{externalPosts.map((post) => <small key={post.id}>ExternalPost {post.externalPostId}{post.externalUrl ? ` · ${post.externalUrl}` : ''}</small>)}{request.failureMessage && <small>{request.failureMessage}</small>}{nextAction === 'NEEDS_HUMAN_ACTION' && <small>NEEDS_HUMAN_ACTION · 需要人工处理后再继续</small>}{request.status === 'DRAFT' && <p><Link className="module-nav-link" href={`/projects/${projectId}/approvals`}>前往 Approval Gate</Link>{approval?.status === 'APPROVED' && approval.targetRevisionId === revision.id && <button type="button" disabled={busy} onClick={() => void queueRequest(request.id)}>进入发布队列</button>}</p>}{request.status === 'PUBLISHED' && <small>PUBLISHED · 已生成 Fake Platform 发布记录</small>}</li>)}</ul></section>
  </main>;
}
