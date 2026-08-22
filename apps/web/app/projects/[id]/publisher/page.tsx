'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Account = { id: string; platformId: string; displayName: string; status: string };
type PublishRequest = { id: string; accountId: string; status: string; failureMessage: string | null; createdAt: string };
type Asset = { id: string; checksum: string; kind: 'VIDEO_RENDER'; lifecycle: 'READY'; byteSize: number };
type RequestAggregate = { request: PublishRequest; revision: { id: string; title: string; description: string; assetId: string }; nextAction: 'NEEDS_HUMAN_ACTION' | null };
type ApiError = { error?: { message?: string } };

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try { return ((await response.json()) as ApiError).error?.message || fallback; }
  catch { return fallback; }
}

export default function PublisherPage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [requests, setRequests] = useState<RequestAggregate[]>([]);
  const [displayName, setDisplayName] = useState('Fake Platform 测试账号');
  const [accountId, setAccountId] = useState('');
  const [assetId, setAssetId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [accountResponse, assetResponse, requestResponse] = await Promise.all([
      fetch(`/api/v1/projects/${projectId}/publisher/accounts`),
      fetch(`/api/v1/projects/${projectId}/publisher/assets`),
      fetch(`/api/v1/projects/${projectId}/publisher/requests`),
    ]);
    if (accountResponse.ok) {
      const nextAccounts = ((await accountResponse.json()) as { items: Account[] }).items;
      setAccounts(nextAccounts);
      setAccountId((current) => current || nextAccounts[0]?.id || '');
    }
    if (assetResponse.ok) {
      const nextAssets = ((await assetResponse.json()) as { items: Asset[] }).items;
      setAssets(nextAssets);
      setAssetId((current) => current || nextAssets[0]?.id || '');
    }
    if (requestResponse.ok) {
      const items = ((await requestResponse.json()) as { items: PublishRequest[] }).items;
      const aggregates = await Promise.all(items.map(async (item) => {
        const response = await fetch(`/api/v1/projects/${projectId}/publisher/requests/${item.id}`);
        return response.ok ? await response.json() as RequestAggregate : { request: item, revision: { id: '', title: item.id, description: '', assetId: '' }, nextAction: null };
      }));
      setRequests(aggregates);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const createFakeAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setMessage('');
    const response = await fetch(`/api/v1/projects/${projectId}/publisher/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platformId: 'fake-platform', displayName: displayName.trim(), status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false } }) });
    setMessage(response.ok ? 'Fake Platform 账号已创建。' : await responseMessage(response, '账号创建失败。'));
    if (response.ok) await refresh();
    setBusy(false);
  };

  const createRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setMessage('');
    const asset = assets.find((item) => item.id === assetId);
    if (!asset) { setMessage('请选择当前项目的可发布成片。'); setBusy(false); return; }
    const response = await fetch(`/api/v1/projects/${projectId}/publisher/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId, idempotencyKey: `operator-${projectId}-${assetId}-${Date.now()}`, correlationId: `operator-${projectId}`, revision: { assetId: asset.id, assetChecksum: asset.checksum, title: title.trim(), description: description.trim(), desiredPublishAt: null, createdBy: 'operator' } }) });
    setMessage(response.ok ? '发布草稿已创建，等待 Approval Gate。' : await responseMessage(response, '发布草稿创建失败。'));
    if (response.ok) await refresh();
    setBusy(false);
  };

  const approveAndQueue = async (requestId: string) => {
    setBusy(true); setMessage('');
    const current = requests.find((item) => item.request.id === requestId);
    if (!current?.revision.id) { setMessage('发布 Revision 信息缺失。'); setBusy(false); return; }
    const revisionId = current.revision.id;
    const pending = await fetch(`/api/v1/projects/${projectId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetType: 'PUBLISH', targetId: requestId, targetRevisionId: revisionId, status: 'PENDING', approver: 'operator' }) });
    if (!pending.ok) { setMessage(await responseMessage(pending, 'Approval Gate 创建失败。')); setBusy(false); return; }
    const approved = await fetch(`/api/v1/projects/${projectId}/approvals/PUBLISH/${requestId}/${revisionId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approver: 'operator' }) });
    if (!approved.ok) { setMessage(await responseMessage(approved, 'Approval Gate 批准失败。')); setBusy(false); return; }
    const queued = await fetch(`/api/v1/projects/${projectId}/publisher/requests/${requestId}/queue`, { method: 'POST' });
    setMessage(queued.ok ? 'Approval Gate 已批准，发布请求已进入 PUBLISH Job 队列。' : await responseMessage(queued, '发布入队失败。'));
    if (queued.ok) await refresh();
    setBusy(false);
  };

  return <main className="shell">
    <header><p className="eyebrow">Project / {projectId}</p><h1>Publisher 工作台</h1><p className="muted">当前只连接 Fake Platform，用于验证 Approval Gate、入队、Worker 执行和发布记录。</p><nav className="module-nav"><Link href={`/projects/${projectId}/director`}>返回 Director</Link></nav></header>
    <section className="grid">
      <form className="card" onSubmit={createFakeAccount}><div className="section-title"><h2>Fake Platform 账号</h2><span>{accounts.length} 个</span></div><label>显示名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label><button disabled={busy}>创建测试账号</button><ul className="revision-list">{accounts.map((account) => <li key={account.id}><strong>{account.displayName}</strong><span>{account.platformId} · {account.status}</span></li>)}</ul></form>
      <form className="card" onSubmit={createRequest}><div className="section-title"><h2>创建发布请求</h2><span>DRAFT</span></div><label>目标账号<select value={accountId} onChange={(event) => setAccountId(event.target.value)} required><option value="">请选择</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label><label>成片 Render Asset<select value={assetId} onChange={(event) => setAssetId(event.target.value)} required><option value="">请选择可发布成片</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.id} · {asset.byteSize} bytes</option>)}</select></label><label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} /></label><label>描述<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label><button disabled={busy || !accountId || !assetId}>保存发布草稿</button></form>
    </section>
    <section className="card"><div className="section-title"><h2>发布请求</h2><span>{requests.length} 条</span></div>{message && <p className="status">{message}</p>}<ul className="revision-list">{requests.map(({ request, revision, nextAction }) => <li key={request.id}><strong>{revision.title}</strong><span>{request.status} · Asset {revision.assetId}</span>{request.failureMessage && <small>{request.failureMessage}</small>}{nextAction === 'NEEDS_HUMAN_ACTION' && <small>NEEDS_HUMAN_ACTION · 需要人工处理后再继续</small>}{request.status === 'DRAFT' && <button type="button" disabled={busy} onClick={() => void approveAndQueue(request.id)}>Approval Gate 批准并入队</button>}{request.status === 'PUBLISHED' && <small>PUBLISHED · 已生成 Fake Platform 发布记录</small>}</li>)}</ul></section>
  </main>;
}
