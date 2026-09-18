'use client';

import { useRouter } from 'next/navigation';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';

type Item = { title: string; script: string; voicePath: string; voiceName?: string };
type PairRow = { status: string; basename: string; script?: string; voicePath?: string; textFile?: string | null; audioFile?: string | null };
type RootStatus = { state: 'idle' | 'scanning' | 'ready' | 'error'; available?: number; unavailable?: number; message?: string };
type Preset = { id: string; name: string; description: string; editModeDefault: 'SCRIPT' | 'RANDOM'; minClipDurationMs: number; maxClipDurationMs: number; preferUnusedMedia: boolean; fps: number };

function applyPresetValues(preset: Preset, setters: { setMinClipDurationMs: (value: number) => void; setMaxClipDurationMs: (value: number) => void; setPreferUnusedMedia: (value: boolean) => void; setFps: (value: number) => void }): void {
  setters.setMinClipDurationMs(preset.minClipDurationMs);
  setters.setMaxClipDurationMs(preset.maxClipDurationMs);
  setters.setPreferUnusedMedia(preset.preferUnusedMedia);
  setters.setFps(preset.fps);
}

function statusText(status: RootStatus | undefined): string {
  if (!status || status.state === 'idle') return '离开输入框后自动扫描';
  if (status.state === 'scanning') return '正在扫描素材…';
  if (status.state === 'error') return status.message || '目录不可用';
  return `✓ ${status.available || 0} 个可用视频${status.unavailable ? ` · ⚠ ${status.unavailable} 个无法读取` : ''}`;
}

export function WorkbenchForm({ mode }: { mode: 'SCRIPT' | 'MIX' }) {
  const router = useRouter();
  const search = useSearchParams();
  const copyId = search.get('copy');
  const [title, setTitle] = useState('');
  const [script, setScript] = useState('');
  const [voicePath, setVoicePath] = useState('');
  const [voiceName, setVoiceName] = useState('');
  const [items, setItems] = useState<Item[]>([{ title: '', script: '', voicePath: '' }]);
  const [textFiles, setTextFiles] = useState('');
  const [audioFiles, setAudioFiles] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairRows, setPairRows] = useState<PairRow[]>([]);
  const [roots, setRoots] = useState(['']);
  const [rootStatuses, setRootStatuses] = useState<Record<number, RootStatus>>({});
  const [outputRoot, setOutputRoot] = useState('');
  const [minClipDurationMs, setMinClipDurationMs] = useState(2000);
  const [maxClipDurationMs, setMaxClipDurationMs] = useState(5000);
  const [seed, setSeed] = useState(1);
  const [variants, setVariants] = useState(1);
  const [fps, setFps] = useState(30);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [preferUnusedMedia, setPreferUnusedMedia] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploadingVoice, setUploadingVoice] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(`contentos-edit-settings-${mode}`) || '{}') as { roots?: string[]; outputRoot?: string; minClipDurationMs?: number; maxClipDurationMs?: number; seed?: number; variants?: number; fps?: number; preferUnusedMedia?: boolean; templateId?: string };
      if (saved.roots?.length) setRoots(saved.roots);
      if (saved.outputRoot) setOutputRoot(saved.outputRoot);
      if (saved.minClipDurationMs) setMinClipDurationMs(saved.minClipDurationMs);
      if (saved.maxClipDurationMs) setMaxClipDurationMs(saved.maxClipDurationMs);
      if (saved.seed) setSeed(saved.seed);
      if (saved.variants === 1 || saved.variants === 3 || saved.variants === 5) setVariants(saved.variants);
      if (saved.fps) setFps(saved.fps);
      if (saved.preferUnusedMedia !== undefined) setPreferUnusedMedia(saved.preferUnusedMedia);
      if (saved.templateId) setTemplateId(saved.templateId);
    } catch { /* ignore malformed local preferences */ }
  }, [mode]);

  useEffect(() => {
    void fetch('/api/v1/edit/presets').then(async (response) => response.ok ? await response.json() as { items: Preset[] } : { items: [] }).then((data) => {
      setPresets(data.items);
      let savedTemplate = '';
      try { savedTemplate = (JSON.parse(window.localStorage.getItem(`contentos-edit-settings-${mode}`) || '{}') as { templateId?: string }).templateId || ''; } catch { /* ignore malformed local preferences */ }
      if (!savedTemplate && data.items[0]) { setTemplateId(data.items[0].id); applyPresetValues(data.items[0], { setMinClipDurationMs, setMaxClipDurationMs, setPreferUnusedMedia, setFps }); }
    }).catch(() => setPresets([]));
  }, [mode]);

  useEffect(() => {
    if (!copyId) return;
    void fetch(`/api/v1/edit/batches/${encodeURIComponent(copyId)}/config`).then(async (response) => {
      if (!response.ok) throw new Error('历史任务配置暂时无法读取。');
      return await response.json() as { mode: 'SCRIPT' | 'MIX'; title: string; script: string; sourceRoots: string[]; outputRoot: string; settings: { minClipDurationMs: number; maxClipDurationMs: number; seed: number; variants: number; fps: number; preferUnusedMedia: boolean; templateId?: string }; items: Item[] };
    }).then((config) => {
      if (config.mode !== mode) return;
      setTitle(`${config.title}（副本）`); setScript(config.script || ''); setRoots(config.sourceRoots.length ? config.sourceRoots : ['']); setOutputRoot(config.outputRoot || ''); setMinClipDurationMs(config.settings.minClipDurationMs); setMaxClipDurationMs(config.settings.maxClipDurationMs); setSeed(config.settings.seed); setVariants(config.settings.variants === 3 || config.settings.variants === 5 ? config.settings.variants : 1); setFps(config.settings.fps); setPreferUnusedMedia(config.settings.preferUnusedMedia); if (config.settings.templateId) setTemplateId(config.settings.templateId); if (mode === 'MIX' && config.items.length) setItems(config.items.map((item) => ({ title: item.title, script: item.script, voicePath: item.voicePath || '', ...(item.voicePath ? { voiceName: item.voicePath.split(/[\\/]/u).pop() } : {}) })));
    }).catch((error) => setMessage(error instanceof Error ? error.message : '历史任务配置暂时无法读取。'));
  }, [copyId, mode]);

  useEffect(() => {
    window.localStorage.setItem(`contentos-edit-settings-${mode}`, JSON.stringify({ roots, outputRoot, minClipDurationMs, maxClipDurationMs, seed, variants, fps, preferUnusedMedia, templateId }));
  }, [mode, roots, outputRoot, minClipDurationMs, maxClipDurationMs, seed, variants, fps, preferUnusedMedia, templateId]);

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
  const pairFiles = async () => {
    const textList = textFiles.split(/[\r\n,，]+/u).map((value) => value.trim()).filter(Boolean);
    const audioList = audioFiles.split(/[\r\n,，]+/u).map((value) => value.trim()).filter(Boolean);
    if (!textList.length || !audioList.length) { setMessage('请先填写文案文件和音频文件路径。'); return; }
    setPairing(true); setMessage('');
    try {
      const response = await fetch('/api/v1/edit/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ textFiles: textList, audioFiles: audioList, includeContent: true }) });
      const data = await response.json() as { items?: PairRow[]; error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message || '文案和音频配对失败。');
      setPairRows(data.items || []);
      const missing = (data.items || []).filter((item) => item.status !== 'READY');
      setMessage(missing.length ? `已识别 ${((data.items || []).length - missing.length)} 条可配对任务；${missing.length} 条存在缺失或重复。请确认后再载入。` : `已识别 ${(data.items || []).length} 条可配对任务，请确认后载入。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '文案和音频配对失败。'); }
    finally { setPairing(false); }
  };
  const loadReadyPairs = () => {
    const ready = pairRows.filter((item) => item.status === 'READY' && item.script).map((item) => ({ title: item.basename, script: item.script || '', voicePath: item.voicePath || '' }));
    if (!ready.length) { setMessage('当前没有可载入的完整配对项。'); return; }
    setItems(ready);
    setMessage(`已载入 ${ready.length} 条已确认配对任务。`);
  };
  const uploadAudio = async (file: File, onReady: (path: string, name: string) => void) => {
    setUploadingVoice(true); setMessage('');
    try {
      const body = new FormData(); body.append('file', file);
      const response = await fetch('/api/v1/edit/uploads/audio', { method: 'POST', body });
      const data = await response.json() as { path?: string; name?: string; error?: { message?: string } };
      if (!response.ok || !data.path) throw new Error(data.error?.message || '音频上传失败，请检查文件后重试。');
      onReady(data.path, data.name || file.name);
    } catch (error) { setMessage(error instanceof Error ? error.message : '音频上传失败，请检查文件后重试。'); }
    finally { setUploadingVoice(false); }
  };
  const handleTemplateChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextId = event.target.value; setTemplateId(nextId);
    const preset = presets.find((item) => item.id === nextId);
    if (preset) applyPresetValues(preset, { setMinClipDurationMs, setMaxClipDurationMs, setPreferUnusedMedia, setFps });
  };
  const submit = async (event?: FormEvent, forceTest = false) => {
    event?.preventDefault(); setBusy(true); setMessage('');
    try {
      if (!outputRoot.trim()) throw new Error('请先填写输出文件夹。');
      const payload = {
        mode,
        ...(title.trim() ? { title: title.trim() } : {}),
        script: mode === 'SCRIPT' ? script : undefined,
        ...(mode === 'SCRIPT' && voicePath.trim() ? { voicePath: voicePath.trim() } : {}),
        items: mode === 'MIX' ? items.filter((item) => (item.script || '').trim()).map((item) => ({ title: (item.title || '').trim() || undefined, script: (item.script || '').trim(), ...((item.voicePath || '').trim() ? { voicePath: (item.voicePath || '').trim() } : {}) })) : undefined,
        testOnly: mode === 'MIX' && forceTest,
        sourceRoots: roots.map((root) => root.trim()).filter(Boolean),
        ...(outputRoot.trim() ? { outputRoot: outputRoot.trim() } : {}),
        minClipDurationMs,
        maxClipDurationMs,
        seed,
        variants: mode === 'MIX' ? variants : 1,
        fps,
        ...(templateId ? { templateId } : {}),
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
        <label>配音文件（可选）<span className="upload-control">选择/上传音频<input aria-label="脚本配音文件" type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAudio(file, (path, name) => { setVoicePath(path); setVoiceName(name); }); event.target.value = ''; }} disabled={uploadingVoice} /></span></label>
        {voiceName && <p className="selected-file">已选择：{voiceName}</p>}
        <label className="path-fallback">本地音频路径（可选）<input value={voicePath} onChange={(event) => { setVoicePath(event.target.value); setVoiceName(event.target.value.split(/[\\/]/u).pop() || ''); }} placeholder="也可以填写服务端授权目录中的路径" /></label>
        <p className="muted">支持上传 mp3、wav、m4a、aac、flac 或 ogg；未填写时会按文案时长剪辑。</p>
      </> : <>
        {items.map((item, index) => <div className="batch-row" key={index}>
          <label>任务 {index + 1} 标题<input value={item.title} onChange={(event) => updateItem(index, { title: event.target.value })} placeholder="可选" /></label>
          <label>文案<textarea value={item.script} onChange={(event) => updateItem(index, { script: event.target.value })} placeholder="输入这一条视频的文案" required /></label>
          <label>配音文件（可选）<span className="upload-control">选择/上传音频<input aria-label={`任务 ${index + 1} 配音文件`} type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAudio(file, (path, name) => updateItem(index, { voicePath: path, voiceName: name })); event.target.value = ''; }} disabled={uploadingVoice} /></span></label>
          {item.voiceName && <p className="selected-file">已选择：{item.voiceName}</p>}
          <label className="path-fallback">本地音频路径（可选）<input value={item.voicePath} onChange={(event) => updateItem(index, { voicePath: event.target.value, voiceName: event.target.value.split(/[\\/]/u).pop() || '' })} placeholder="也可以填写服务端授权目录中的路径" /></label>
          {items.length > 1 && <button type="button" onClick={() => setItems((current) => current.filter((_, rowIndex) => rowIndex !== index))}>删除这条</button>}
        </div>)}
        <button type="button" className="secondary-action" onClick={() => setItems((current) => [...current, { title: '', script: '', voicePath: '' }])}>+ 添加一条</button>
        <details className="batch-pairing"><summary>按文件名自动配对文案和音频</summary><label>文案文件路径（每行一个）<textarea value={textFiles} onChange={(event) => setTextFiles(event.target.value)} placeholder="F:\\文案\\001.txt\nF:\\文案\\002.md" /></label><label>音频文件路径（每行一个）<textarea value={audioFiles} onChange={(event) => setAudioFiles(event.target.value)} placeholder="F:\\音频\\001.mp3\nF:\\音频\\002.wav" /></label><button type="button" className="secondary-action" onClick={() => void pairFiles()} disabled={pairing}>{pairing ? '正在配对…' : '检查文件名配对'}</button><p className="muted">相同文件名会自动配对；缺少或重复的条目会明确标记，不会悄悄跳过。</p>{pairRows.length > 0 && <><ul className="pair-preview">{pairRows.map((row) => <li key={`${row.basename}-${row.status}`}><strong>{row.basename}</strong><span>{row.status === 'READY' ? '✓ 已配对' : row.status === 'MISSING_AUDIO' ? '⚠ 缺少音频' : row.status === 'MISSING_TEXT' ? '⚠ 缺少文案' : `⚠ 重复文件名（${row.status}）`}</span></li>)}</ul><button type="button" className="secondary-action" onClick={loadReadyPairs}>仅载入已确认配对项</button></>}</details>
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
      <div className="section-title"><h2>3. 输出位置</h2><span>开始前必须确认</span></div>
      <label>输出文件夹<input value={outputRoot} onChange={(event) => setOutputRoot(event.target.value)} placeholder="例如：F:\\ContentOS输出\\2026-09-18" required /></label>
      <p className="muted">目录必须已存在、可写，并位于服务端允许范围内；权限仅作只读校验，完成后可直接导出成片。</p>
    </section>
    <details className="card advanced-settings"><summary>4. 高级设置</summary>
      <div className="grid"><label>剪辑模板<select value={templateId} onChange={handleTemplateChange}>{presets.length === 0 ? <option value="">默认短视频</option> : presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label><label>素材选择策略<select value={preferUnusedMedia ? 'RECOMMENDED' : 'RANDOM'} onChange={(event) => setPreferUnusedMedia(event.target.value === 'RECOMMENDED')}><option value="RECOMMENDED">优先较少使用</option><option value="RANDOM">随机</option></select></label><label>镜头最短时长（秒）<input type="number" min={0.5} step={0.5} value={minClipDurationMs / 1000} onChange={(event) => setMinClipDurationMs(Math.round((Number(event.target.value) || 0.5) * 1000))} /></label><label>镜头最长时长（秒）<input type="number" min={0.5} step={0.5} value={maxClipDurationMs / 1000} onChange={(event) => setMaxClipDurationMs(Math.round((Number(event.target.value) || 0.5) * 1000))} /></label><label>视频帧率<select value={fps} onChange={(event) => setFps(Number(event.target.value))}><option value={24}>24 fps</option><option value={25}>25 fps</option><option value={30}>30 fps</option><option value={50}>50 fps</option><option value={60}>60 fps</option></select></label>{mode === 'MIX' && <label>每条生成版本数<select value={variants} onChange={(event) => setVariants(Number(event.target.value))}><option value={1}>1</option><option value={3}>3</option><option value={5}>5</option></select></label>}</div>
      <p className="muted">片头、片尾和品牌素材继续沿用现有模板配置，不会混入普通素材候选。</p>
    </details>
    {message && <p className="form-error">{message}</p>}
    {mode === 'MIX' && <button type="button" className="secondary-action" onClick={() => void submit(undefined, true)} disabled={busy}>生成 1 条测试</button>}
    <button className="primary-action" type="submit" disabled={busy}>{busy ? '正在准备素材……' : mode === 'SCRIPT' ? '开始剪辑' : '开始全部混剪'}</button>
  </form>;
}
