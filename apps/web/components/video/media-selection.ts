export function mergeNewMediaSelections(current: string[], discovered: string[], previouslyIndexed: string[]): string[] {
  const previous = new Set(previouslyIndexed);
  return [...new Set([...current, ...discovered.filter((id) => !previous.has(id))])];
}
