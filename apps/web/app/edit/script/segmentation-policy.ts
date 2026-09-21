type SegmentationSettings = { mode: string; delimiters?: string[] };

export function segmentationChanged(previous: SegmentationSettings, next: SegmentationSettings): boolean {
  if (previous.mode !== next.mode) return true;
  const previousDelimiters = [...(previous.delimiters || [])].sort();
  const nextDelimiters = [...(next.delimiters || [])].sort();
  return previousDelimiters.length !== nextDelimiters.length || previousDelimiters.some((delimiter, index) => delimiter !== nextDelimiters[index]);
}
