export function isCurrentManifest(manifestId: string, currentId?: string): boolean { return Boolean(currentId && manifestId === currentId); }

export function ManifestRevisionPicker({ revisions, selectedId, currentId, onSelect }: { revisions: Array<{ id: string; revision: number; status?: string }>; selectedId?: string; currentId?: string; onSelect: (id: string) => void }) {
  return <label>Manifest Revision<select value={selectedId || ''} onChange={(event) => onSelect(event.target.value)}><option value="" disabled>选择版本</option>{revisions.map((item) => <option key={item.id} value={item.id}>v{item.revision} · {isCurrentManifest(item.id, currentId) ? '当前版本' : '历史版本'}</option>)}</select></label>;
}
