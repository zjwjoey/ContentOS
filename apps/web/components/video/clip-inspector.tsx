import { useEffect, useState } from 'react';
export type AdjustmentOperation = Record<string, unknown>;
export function buildReorderIndexes(index: number, clipCount: number): number[] {
  const indexes = Array.from({ length: clipCount }, (_, item) => item);
  if (index > 0 && index < clipCount) [indexes[index - 1], indexes[index]] = [indexes[index]!, indexes[index - 1]!];
  return indexes;
}
export function buildReplaceOperation(index: number, assetId: string): AdjustmentOperation { return { type: 'REPLACE', clipIndex: index, assetId }; }
type ReplacementAsset = { id: string; originalName?: string };
export function ClipInspector({ clip, index, clipCount = 1, replacementAssets = [], editable = true, busy = false, onOperation }: { clip?: { assetId: string; sourceInMs: number; durationMs: number }; index: number | null; clipCount?: number; replacementAssets?: ReplacementAsset[]; editable?: boolean; busy?: boolean; onOperation: (operation: AdjustmentOperation) => void }) {
  const [sourceInMs, setSourceInMs] = useState(clip?.sourceInMs || 0); const [durationMs, setDurationMs] = useState(clip?.durationMs || 1000);
  const [replacementAssetId, setReplacementAssetId] = useState('');
  useEffect(() => { setSourceInMs(clip?.sourceInMs || 0); setDurationMs(clip?.durationMs || 1000); setReplacementAssetId(''); }, [clip?.assetId, clip?.sourceInMs, clip?.durationMs, index]);
  if (!clip || index === null) return <div className="feedback">选择一个镜头查看 Inspector。</div>;
  const reorder = buildReorderIndexes(index, clipCount); const availableReplacements = replacementAssets.filter((asset) => asset.id !== clip.assetId);
  return <div><p className="muted">镜头 {index + 1} · {clip.assetId}</p>{!editable && <p className="status">当前正在查看历史 Manifest。历史版本仅供查看，请切回当前版本后再调整。</p>}<label>起始位置（ms）<input type="number" value={sourceInMs} onChange={(event) => setSourceInMs(Number(event.target.value))} disabled={!editable || busy} /></label><label>时长（ms）<input type="number" value={durationMs} onChange={(event) => setDurationMs(Number(event.target.value))} disabled={!editable || busy} /></label><label>替换素材<select value={replacementAssetId} onChange={(event) => setReplacementAssetId(event.target.value)} disabled={!editable || busy}><option value="">选择 READY 视频</option>{availableReplacements.map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName || asset.id}</option>)}</select></label><div className="inspector-actions"><button type="button" disabled={!editable || busy} onClick={() => onOperation({ type: 'TRIM', clipIndex: index, sourceInMs, durationMs })}>TRIM</button><button type="button" disabled={!editable || busy} onClick={() => onOperation({ type: 'REMOVE', clipIndex: index })}>REMOVE</button><button type="button" disabled={!editable || busy || clipCount < 2} onClick={() => onOperation({ type: 'REORDER', clipIndexes: reorder })}>REORDER</button><button type="button" disabled={!editable || busy || !replacementAssetId} onClick={() => onOperation(buildReplaceOperation(index, replacementAssetId))}>REPLACE</button><button type="button" disabled={!editable || busy} onClick={() => onOperation({ type: 'REROLL', clipIndex: index })}>REROLL</button></div></div>;
}
