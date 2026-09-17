export function reconcileMediaSelections(input: { selectedIds: string[]; previousKnownIds: string[]; currentAvailableIds: string[] }): { selectedIds: string[]; knownIds: string[] } {
  const previous = new Set(input.previousKnownIds);
  const selected = new Set(input.selectedIds);
  const current = [...new Set(input.currentAvailableIds)];
  return { selectedIds: current.filter((id) => selected.has(id) || !previous.has(id)), knownIds: current };
}

export function mergeNewMediaSelections(current: string[], discovered: string[], previouslyIndexed: string[]): string[] {
  const previous = new Set(previouslyIndexed);
  return [...new Set([...current, ...discovered.filter((id) => !previous.has(id))])];
}
