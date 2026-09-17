type MediaItem = { id: string; originalName: string; durationMs: number; tags?: string[]; category?: string; usageCount?: number; lastUsedAt?: string; thumbnailStatus?: string; thumbnailUrl?: string };

function seconds(value: number): string { return `${(value / 1000).toFixed(1)} 秒`; }
function usageText(value: number): string { return value > 0 ? `使用 ${value} 次` : '从未使用'; }

export function MediaBrowser({ assets, selected, onToggle, onEdit, emptyText = '暂无可用素材。' }: { assets: MediaItem[]; selected: string[]; onToggle: (id: string) => void; onEdit?: (asset: MediaItem) => void; emptyText?: string }) {
  if (assets.length === 0) return <p className="muted">{emptyText}</p>;
  return <div className="media-browser" aria-label="素材浏览器">{assets.map((asset) => <article className={`media-card${selected.includes(asset.id) ? ' selected' : ''}`} key={asset.id}>
    <button type="button" className="media-card-select" onClick={() => onToggle(asset.id)} aria-label={`${selected.includes(asset.id) ? '取消选择' : '选择'} ${asset.originalName}`}>
      {asset.thumbnailStatus === 'PENDING' ? <span className="media-thumb-placeholder">正在生成预览</span> : asset.thumbnailStatus === 'FAILED' ? <span className="media-thumb-placeholder">暂无预览</span> : asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" loading="lazy" /> : <span className="media-thumb-placeholder">暂无预览</span>}
      <strong>{asset.originalName}</strong><small>{seconds(asset.durationMs)} · {usageText(asset.usageCount || 0)}</small><small>{[asset.category, ...(asset.tags || [])].filter(Boolean).join(' · ') || '未分类'}</small>
    </button>
    {onEdit && <button type="button" className="media-card-edit" onClick={() => onEdit(asset)}>编辑素材信息</button>}
  </article>)}</div>;
}
