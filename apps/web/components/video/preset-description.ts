export type PresetDescriptionInput = { editModeDefault: 'SCRIPT' | 'RANDOM'; minClipDurationMs: number; maxClipDurationMs: number; preferUnusedMedia: boolean; introAssetId: string | null; outroAssetId: string | null };

export function describePreset(preset: PresetDescriptionInput | null): string {
  if (!preset) return '默认剪辑设置';
  const mode = preset.editModeDefault === 'SCRIPT' ? '按脚本剪辑' : '随机混剪';
  const duration = `${(preset.minClipDurationMs / 1000).toFixed(1).replace(/\.0$/u, '')}–${(preset.maxClipDurationMs / 1000).toFixed(1).replace(/\.0$/u, '')}秒`;
  return [mode, duration, ...(preset.preferUnusedMedia ? ['优先少重复'] : []), ...(preset.introAssetId ? ['固定片头'] : []), ...(preset.outroAssetId ? ['固定片尾'] : [])].join(' · ');
}
