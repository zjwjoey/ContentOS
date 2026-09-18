'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

type Item = { title: string; script: string; voicePath: string };
type RootStatus = { state: 'idle' | 'scanning' | 'ready' | 'error'; available?: number; unavailable?: number; message?: string };

function statusText(status: RootStatus | undefined): string {
  if (!status || status.state === 'idle') return '离开输入框后自动扫描';
  if (status.state === 'scanning') return '正在扫描素材…';
  if (status.state === 'error') return status.message || '目录不可用';
  return `✓ ${status.available || 0} 个可用视频${status.unavailable ? ` · ⚠ ${status.unavailable} 个无法读取` : ''}`;
}

export function WorkbenchForm({ mode }: { mode: 'SCRIPT' | 'MIX' }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [script, setScript] = useState('');
  const [voicePath, setVoicePath] = useState('');
  const [items, setItems] = useState<Item[]>([{ title: '', script: '', voicePath: '' }]);
  const [roots, setRoots] = useState(['']);
  const [rootStatuses, setRootStatuses] = useState<Record<number, RootStatus>>({});
  const [outputRoot, setOutputRoot] = useState('');
  const [minClipDurationMs, setMinClipDurationMs] = useState(2000);
  const [maxClipDurationMs, setMaxClipDurationMs] = useState(5000);
  const [seed, setSeed] = useState(1);
  const [preferUnusedMedia, setPreferUnusedMedia] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const updateItem = (index: number, patch: Partial<Item>) => setItems((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  const addRoot = () => setRoots((current) => [...current, '']);
  const removeRoot = (index: number) => {
    setRoots((current) => current.length === 1 ? current : current.filter((_, itemIndex) => itemIndex !== index));
    setRootStatuses((current) => Object.fromEntries(Object.entries(current).filter(([key]) => Number(key) !== index)));
  };
  const scanRoot = async (index: number) => {
    const sourceRoot = roots[index]?.trim();
    if (!sourceRoot) return;
    setRootStatuses((current) => ({ ...current, [index]: { state: 'scanning' } }));
    try {
      const response = await fetch('/api/v1/edit/sources/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceRoots: [sourceRoot] }) });
      const data = await response.json() as { items?: Array<{ available: number; unavailable: number }>; error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message || '素材目录扫描失败，请检查路径和权限。');
      const item = data.items?.[0];
      setRootStatuses((current) => ({ ...current, [index]: { state: 'ready', available: item?.available || 0, unavailable: item?.unavailable || 0 } }));
    } catch (error) {
      setRootStatuses((current) => ({ ...current, [index]: { state: 'error', message: error instanceof Error ? error.message : '素材目录扫描失败。' } }));
    }
  };
  const submit = async (event?: FormEvent, forceTest = false) => {
    event?.preventDefault(); setBusy(true); setMessage('');
    try {
      const payload = {
        mode,
        ...(title.trim() ? { title: title.trim() } : {}),
        script: mode === 'SCRIPT' ? script : undefined,
        ...(mode === 'SCRIPT' && voicePath.trim() ? { voicePath: voicePath.trim() } : {}),
        items: mode === 'MIX' ? items.filter((item) => item.script.trim()).map((item) => ({ title: item.title.trim() || undefined, script: item.script.trim(), ...(item.voicePath.trim() ? { voicePath: item.voicePath.trim() } : {}) })) : undefined,
        testOnly: mode === 'MIX' && forceTest,
        sourceRoots: roots.map((root) => root.trim()).filter(Boolean),
        ...(outputRoot.trim() ? { outputRoot: outputRoot.trim() } : {}),
        minClipDurationMs,
        maxClipDurationMs,
        seed,
        preferUnusedMedia,
      };
      const response = await fetch('/api/v1/edit/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await response.json() as { batchId?: string; error?: { message?: string } };
      if (!response.ok || !data.batchId) throw new Error(data.error?.message || '剪辑任务创建失败。');
      router.push(`/edit/history?batch=${encodeURIComponent(data.batchId)}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '剪辑任务创建失败。'); }
    finally { setBusy(false); }
  };

  return <form className="edit-form" onSubmit={(event) => void submit(event)}>
    <section className="card">
      <div className="section-title"><h2>1. 文案与音频</h2><span>{mode === 'MIX' ? `${items.length} 条任务` : '自动识别段落'}</span></div>
      <label>任务名称（可选）<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={mode === 'MIX' ? '例如：门店宣传混剪' : '例如：Action 研究视频'} /></label>
      {mode === 'SCRIPT' ? <>
        <label>输入视频文案<textarea value={script} onChange={(event) => setScript(event.target.value)} placeholder="把要表达的内容粘贴到这里……" required /></label>
        <label>配音文件路径（可选）<input value={voicePath} onChange={(event) => setVoicePath(event.target.value)} placeholder="例如：F:\\音频\\旁白.mp3" /></label>
        <p className="muted">支持服务端授权目录中的 mp3、wav、m4a 或 aac 音频；未填写时会按文案时长剪辑。</p>
      </> : <>
        {items.map((item, index) => <div className="batch-row" key={index}>
          <label>任务 {index + 1} 标题<input value={item.title} onChange={(event) => updateItem(index, { title: event.target.value })} placeholder="可选" /></label>
          <label>文案<textarea value={item.script} onChange={(event) => updateItem(index, { script: event.target.value })} placeholder="输入这一条视频的文案" required /></label>
          <label>配音路径<input value={item.voicePath} onChange={(event) => updateItem(index, { voicePath: event.target.value })} placeholder="可选：F:\\音频\\001.mp3" /></label>
          {items.length > 1 && <button type="button" onClick={() => setItems((current) => current.filter((_, rowIndex) => rowIndex !== index))}>删除这条</button>}
        </div>)}
        <button type="button" className="secondary-action" onClick={() => setItems((current) => [...current, { title: '', script: '', voicePath: '' }])}>+ 添加一条</button>
        <p className="muted">可按任务逐条填写文案和音频；服务端会校验音频路径，不会悄悄跳过无效文件。</p>
      </>}
    </section>
    <section className="card">
      <div className="section-title"><h2>2. 素材文件夹</h2><span>支持多个目录</span></div>
      {roots.map((root, index) => <div className="folder-row" key={index}>
        <label><span>素材目录 {index + 1}</span><input value={root} onChange={(event) => { setRoots((current) => current.map((value, rootIndex) => rootIndex === index ? event.target.value : value)); setRootStatuses((current) => ({ ...current, [index]: { state: 'idle' } })); }} onBlur={() => void scanRoot(index)} placeholder="例如：F:\\素材\\商品" required /></label>
        <span className={`folder-status ${rootStatuses[index]?.state || 'idle'}`}>{statusText(rootStatuses[index])}</span>
        {roots.length > 1 && <button type="button" onClick={() => removeRoot(index)}>删除</button>}
      </div>)}
      <button type="button" className="secondary-action" onClick={addRoot}>+ 添加素材文件夹</button>
      <p className="muted">目录离开输入框后会自动验证和扫描，结果会保存在本次剪辑的来源快照中。</p>
    </section>
    <section className="card">
      <div className="section-title"><h2>3. 输出位置</h2><span>可选</span></div>
      <label>输出文件夹<input value={outputRoot} onChange={(event) => setOutputRoot(event.target.value)} placeholder="例如：F:\\ContentOS输出\\2026-09-18" /></label>
      <p className="muted">如填写，目录必须已存在、可写，并位于 CONTENTOS_OUTPUT_ROOTS 允许范围内；完成后可导出成片。</p>
    </section>
    <details className="card advanced-settings"><summary>4. 高级设置</summary>
      <div className="grid"><label>剪辑模板<select defaultValue={mode === 'SCRIPT' ? 'SCRIPT' : 'RANDOM'}><option value="SCRIPT">脚本匹配</option><option value="RANDOM">随机混剪</option></select></label><label>素材选择策略<select value={preferUnusedMedia ? 'RECOMMENDED' : 'RANDOM'} onChange={(event) => setPreferUnusedMedia(event.target.value === 'RECOMMENDED')}><option value="RECOMMENDED">优先较少使用</option><option value="RANDOM">随机</option></select></label><label>镜头最短时长（毫秒）<input type="number" min={500} step={100} value={minClipDurationMs} onChange={(event) => setMinClipDurationMs(Number(event.target.value) || 500)} /></label><label>镜头最长时长（毫秒）<input type="number" min={500} step={100} value={maxClipDurationMs} onChange={(event) => setMaxClipDurationMs(Number(event.target.value) || 500)} /></label><label>可复现种子<input type="number" step={1} value={seed} onChange={(event) => setSeed(Number(event.target.value) || 1)} /></label></div>
      <p className="muted">片头、片尾和品牌素材继续沿用现有模板配置，不会混入普通素材候选。</p>
    </details>
    {message && <p className="form-error">{message}</p>}
    {mode === 'MIX' && <button type="button" className="secondary-action" onClick={() => void submit(undefined, true)} disabled={busy}>生成 1 条测试</button>}
    <button className="primary-action" type="submit" disabled={busy}>{busy ? '正在准备素材……' : mode === 'SCRIPT' ? '开始剪辑' : '开始全部混剪'}</button>
  </form>;
}
