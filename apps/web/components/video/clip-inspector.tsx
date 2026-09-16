import { useEffect, useState } from 'react';
export type AdjustmentOperation = Record<string, unknown>;
export function buildReorderIndexes(index: number, clipCount: number): number[] {
  const indexes = Array.from({ length: clipCount }, (_, item) => item);
  if (index > 0 && index < clipCount) [indexes[index - 1], indexes[index]] = [indexes[index]!, indexes[index - 1]!];
  return indexes;
}
export function buildReplaceOperation(index: number, assetId: string): AdjustmentOperation { return { type: 'REPLACE', clipIndex: index, assetId }; }
type ReplacementAsset = { id: string; originalName?: string; durationMs?: number };
export function ClipInspector({ clip, index, clipCount = 1, replacementAssets = [], mode = 'RANDOM', editable = true, busy = false, onOperation }: { clip?: { assetId: string; sourceInMs: number; durationMs: number; sentenceText?: string }; index: number | null; clipCount?: number; replacementAssets?: ReplacementAsset[]; mode?: 'SCRIPT' | 'RANDOM'; editable?: boolean; busy?: boolean; onOperation: (operation: AdjustmentOperation) => void }) {
  const [sourceInMs, setSourceInMs] = useState(clip?.sourceInMs || 0); const [durationMs, setDurationMs] = useState(clip?.durationMs || 1000);
  const [replacementAssetId, setReplacementAssetId] = useState('');
  useEffect(() => { setSourceInMs(clip?.sourceInMs || 0); setDurationMs(clip?.durationMs || 1000); setReplacementAssetId(''); }, [clip?.assetId, clip?.sourceInMs, clip?.durationMs, index]);
  if (!clip || index === null) return <div className="feedback">选择一个镜头查看镜头设置。</div>;
  const reorder = buildReorderIndexes(index, clipCount); const availableReplacements = replacementAssets.filter((asset) => asset.id !== clip.assetId);
  // Operation protocol values remain TRIM / REMOVE / REORDER / REPLACE / REROLL; labels are Chinese for operators.
  return <div><p className="muted">镜头 {index + 1} · 当前素材</p>{!editable && <p className="status">当前正在查看历史剪辑版本。历史版本仅供查看，请切回当前版本后再调整。</p>}<label>起始位置（ms）<input type="number" value={sourceInMs} onChange={(event) => setSourceInMs(Number(event.target.value))} disabled={!editable || busy} /></label><label>时长（ms）<input type="number" value={durationMs} onChange={(event) => setDurationMs(Number(event.target.value))} disabled={!editable || busy} /></label><label>替换素材<select value={replacementAssetId} onChange={(event) => setReplacementAssetId(event.target.value)} disabled={!editable || busy}><option value="">选择可用视频</option>{availableReplacements.map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName || '视频素材'}</option>)}</select></label><div className="inspector-actions"><button type="button" disabled={!editable || busy} onClick={() => onOperation({ type: 'TRIM', clipIndex: index, sourceInMs, durationMs })}>裁剪</button><button type="button" disabled={!editable || busy} onClick={() => onOperation({ type: 'REMOVE', clipIndex: index })}>移除</button><button type="button" disabled={!editable || busy || clipCount < 2} onClick={() => onOperation({ type: 'REORDER', clipIndexes: reorder })}>调整顺序</button><button type="button" disabled={!editable || busy || !replacementAssetId} onClick={() => onOperation(buildReplaceOperation(index, replacementAssetId))}>替换素材</button><button type="button" disabled={!editable || busy} onClick={() => onOperation({ type: mode === 'SCRIPT' ? 'REMATCH' : 'REROLL', clipIndex: index })}>{mode === 'SCRIPT' ? '重新匹配' : '随机换一个'}</button></div></div>;
}
