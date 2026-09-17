import { useMemo, useState } from 'react';
import { MediaBrowser } from './media-browser';

export type PresetAsset = { id: string; originalName: string; durationMs: number; tags?: string[]; category?: string; thumbnailStatus?: string; thumbnailUrl?: string };

export function PresetAssetPicker({ label, value, assets, onChange }: { label: string; value: string | null; assets: PresetAsset[]; onChange: (value: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<string | null>(value);
  const selected = assets.find((asset) => asset.id === value);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? assets.filter((asset) => `${asset.originalName} ${(asset.tags || []).join(' ')} ${asset.category || ''}`.toLowerCase().includes(normalized)) : assets;
  }, [assets, query]);
  const begin = () => { setDraft(value); setQuery(''); setOpen(true); };
  const confirm = () => { onChange(draft); setOpen(false); };
  return <div className="preset-branding-picker">
    <div className="preset-branding-label"><span>{label}</span>{selected ? <strong>{selected.originalName}</strong> : <span className="muted">当前未设置</span>}</div>
    <div className="preset-branding-actions"><button type="button" onClick={begin}>{selected ? '更换' : `选择${label}`}</button>{selected && <button type="button" onClick={() => onChange(null)}>移除</button>}</div>
    {open && <div className="preset-picker-dialog" role="dialog" aria-label={`选择${label}`}>
      <div className="section-title"><h3>选择{label}</h3><button type="button" onClick={() => setOpen(false)}>关闭</button></div>
      <input aria-label="搜索素材" placeholder="搜索素材" value={query} onChange={(event) => setQuery(event.target.value)} />
      <MediaBrowser assets={filtered} selected={draft ? [draft] : []} onToggle={(id) => setDraft((current) => current === id ? null : id)} emptyText="暂无可复用的品牌素材。" />
      <div className="review-actions"><button type="button" onClick={() => setDraft(null)}>取消选择</button><button type="button" className="primary-action" onClick={confirm}>确认</button></div>
    </div>}
  </div>;
}
