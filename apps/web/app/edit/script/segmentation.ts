export type ScriptSegment = { index: number; text: string; normalizedText: string };

export function mergeScriptSegmentsV1(items: ScriptSegment[], index: number): ScriptSegment[] {
  if (index < 0 || index >= items.length - 1) return items;
  const merged = `${items[index]!.text}${items[index + 1]!.text}`;
  return items
    .filter((_, itemIndex) => itemIndex !== index + 1)
    .map((item, itemIndex) => itemIndex === index
      ? { ...item, text: merged, normalizedText: merged.normalize('NFKC').toLowerCase() }
      : { ...item, index: itemIndex });
}

export function splitScriptSegmentV1(items: ScriptSegment[], index: number, at: number): ScriptSegment[] {
  const item = items[index];
  if (!item || at <= 0 || at >= item.text.length) return items;
  const left = item.text.slice(0, at).trim();
  const right = item.text.slice(at).trim();
  if (!left || !right) return items;
  return [
    ...items.slice(0, index),
    { index, text: left, normalizedText: left.normalize('NFKC').toLowerCase() },
    { index: index + 1, text: right, normalizedText: right.normalize('NFKC').toLowerCase() },
    ...items.slice(index + 1).map((entry, offset) => ({ ...entry, index: index + offset + 2 })),
  ];
}
