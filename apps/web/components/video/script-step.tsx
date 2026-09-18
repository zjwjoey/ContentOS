import { EditModeSelector, type EditMode } from './edit-mode-selector';

export type ScriptPreset = { id: string; name: string; description: string; editModeDefault: EditMode; minClipDurationMs: number; maxClipDurationMs: number; preferUnusedMedia: boolean; introAssetId: string | null; outroAssetId: string | null };
export type ScriptInfo = { revision: number };

export function ScriptStep({ preset, presets, mode, scriptSource, script, scriptInfo, scriptCount, describePreset, onPresetChange, onModeChange, onScriptSourceChange, onScriptChange, onNext }: { preset: ScriptPreset | null; presets: ScriptPreset[]; mode: EditMode; scriptSource: 'PROJECT' | 'CUSTOM'; script: string; scriptInfo: ScriptInfo | null; scriptCount: number; describePreset: (preset: ScriptPreset | null) => string; onPresetChange: (preset: ScriptPreset) => void | Promise<void>; onModeChange: (mode: EditMode) => void; onScriptSourceChange: (source: 'PROJECT' | 'CUSTOM') => void; onScriptChange: (value: string) => void; onNext: () => void }) {
  return <section className="workflow-panel">
    <div className="section-title"><h2>① 准备文案</h2><span>{scriptCount ? `共 ${scriptCount} 句话` : '每句话对应一个镜头'}</span></div>
    <label>剪辑模板<select aria-label="剪辑模板" value={preset?.id || ''} onChange={(event) => { const selected = presets.find((item) => item.id === event.target.value); if (selected) void onPresetChange(selected); }}><option value="">选择模板</option>{presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {preset && <p className="muted">已应用：{describePreset(preset)}</p>}
    <h3>剪辑方式</h3><EditModeSelector mode={mode} onSelect={onModeChange} />
    <fieldset><legend>文案来源</legend><label className="inline-check"><input type="radio" checked={scriptSource === 'PROJECT'} onChange={() => onScriptSourceChange('PROJECT')} />使用当前项目脚本</label><label className="inline-check"><input type="radio" checked={scriptSource === 'CUSTOM'} onChange={() => onScriptSourceChange('CUSTOM')} />粘贴其他文案</label></fieldset>
    {scriptSource === 'PROJECT' && scriptInfo ? <p className="status">已加载当前项目脚本 · 版本 {scriptInfo.revision} · 已载入 {scriptCount} 句话</p> : scriptSource === 'PROJECT' ? <p className="muted">当前项目暂无可用脚本。</p> : <textarea aria-label="脚本文案" value={script} onChange={(event) => onScriptChange(event.target.value)} placeholder="粘贴文案，每句话会自动匹配一个画面。" />}
    {scriptSource === 'PROJECT' && scriptInfo && <textarea aria-label="脚本文案" value={script} onChange={(event) => onScriptChange(event.target.value)} />}
    <button type="button" className="primary-action" onClick={onNext} disabled={!mode || !script.trim()}>下一步：选择素材</button>
  </section>;
}
