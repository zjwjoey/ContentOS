export function isCurrentManifest(manifestId: string, currentId?: string): boolean { return Boolean(currentId && manifestId === currentId); }

export function ManifestRevisionPicker({ revisions, selectedId, currentId, onSelect }: { revisions: Array<{ id: string; revision: number; status?: string }>; selectedId?: string; currentId?: string; onSelect: (id: string) => void }) {
  return <label>剪辑清单版本<select value={selectedId || ''} onChange={(event) => onSelect(event.target.value)}><option value="" disabled>选择版本</option>{revisions.map((item) => <option key={item.id} value={item.id}>第 {item.revision} 版 · {isCurrentManifest(item.id, currentId) ? '当前版本' : '历史版本'}</option>)}</select></label>;
}
