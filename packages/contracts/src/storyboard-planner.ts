export interface StoryboardSceneAssetBindingV1 {
  sceneIndex: number;
  assetIds: ReadonlyArray<string>;
}

export function validateStoryboardSceneAssetBindingsV1(bindings: ReadonlyArray<StoryboardSceneAssetBindingV1>): void {
  if (!Array.isArray(bindings) || bindings.length === 0) throw new Error('sceneAssetBindings must contain at least one scene');
  const indexes = new Set<number>();
  for (const binding of bindings) {
    if (!Number.isInteger(binding.sceneIndex) || binding.sceneIndex <= 0) throw new Error('sceneAssetBindings.sceneIndex must be positive');
    if (indexes.has(binding.sceneIndex)) throw new Error(`duplicate sceneAssetBindings sceneIndex: ${binding.sceneIndex}`);
    indexes.add(binding.sceneIndex);
    if (!Array.isArray(binding.assetIds) || binding.assetIds.length === 0) throw new Error(`scene ${binding.sceneIndex} must bind at least one asset`);
    if (binding.assetIds.some((id: string) => typeof id !== 'string' || id.trim().length === 0))
      throw new Error(`scene ${binding.sceneIndex} contains an invalid asset id`);
    if (new Set(binding.assetIds).size !== binding.assetIds.length) throw new Error(`scene ${binding.sceneIndex} contains duplicate asset ids`);
  }
}
