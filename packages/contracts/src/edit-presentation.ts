export type PresentationAspectRatioV1 = '9:16' | '16:9' | '1:1';
export type PresentationFitModeV1 = 'FILL' | 'CONTAIN' | 'BLUR_BACKGROUND';
export type SubtitleAnimationV1 = 'NONE' | 'FADE_IN' | 'FADE_OUT' | 'FADE_IN_OUT' | 'SLIDE_UP';
export type SubtitleAlignV1 = 'LEFT' | 'CENTER' | 'RIGHT';

export interface CanvasSettingsV1 {
  aspectRatio: PresentationAspectRatioV1;
  width: number;
  height: number;
  fps: number;
  fitMode: PresentationFitModeV1;
}

export interface SubtitleStyleV1 {
  schemaVersion: 'EDIT_PRESENTATION_V1';
  enabled: boolean;
  fontId: string;
  fontFile?: string;
  fontSize: number;
  color: string;
  outline: { enabled: boolean; color: string; width: number };
  shadow: { enabled: boolean; color: string; x: number; y: number; offsetX?: number; offsetY?: number; blur: number; opacity?: number };
  background: { enabled: boolean; color: string; opacity: number; padding: number };
  position: { x: number; y: number };
  align: SubtitleAlignV1;
  maxWidth: number;
  maxLines: number;
  lineHeight: number;
  animation: SubtitleAnimationV1;
  animationDurationMs: number;
}

export type SegmentationModeV1 = 'COMMA_SENTENCE' | 'SENTENCE_ONLY' | 'CUSTOM';
export interface SegmentationSettingsV1 { version: 'SCRIPT_SEGMENTATION_V1'; mode: SegmentationModeV1; delimiters?: string[] }

export interface OutputSettingsV1 {
  outputRoot?: string;
  format: 'mp4';
  videoCodec: 'h264';
  audioCodec: 'aac';
}

export interface PresentationSettingsV1 {
  schemaVersion: 'EDIT_PRESENTATION_V1';
  canvas: CanvasSettingsV1;
  subtitleStyle: SubtitleStyleV1;
  output: OutputSettingsV1;
  segmentation: SegmentationSettingsV1;
}

export const DEFAULT_CANVAS_SETTINGS_V1: CanvasSettingsV1 = { aspectRatio: '9:16', width: 1080, height: 1920, fps: 30, fitMode: 'FILL' };
export const DEFAULT_SUBTITLE_STYLE_V1: SubtitleStyleV1 = {
  schemaVersion: 'EDIT_PRESENTATION_V1', enabled: true, fontId: 'sans-serif', fontSize: 48, color: '#FFFFFF',
  outline: { enabled: true, color: '#000000', width: 2 }, shadow: { enabled: false, color: '#000000', x: 2, y: 2, offsetX: 2, offsetY: 2, blur: 0, opacity: .5 },
  background: { enabled: false, color: '#000000', opacity: 0.45, padding: 12 }, position: { x: 0.5, y: 0.86 }, align: 'CENTER',
  maxWidth: 0.88, maxLines: 2, lineHeight: 1.2, animation: 'FADE_IN_OUT', animationDurationMs: 250,
};
export const DEFAULT_PRESENTATION_SETTINGS_V1: PresentationSettingsV1 = { schemaVersion: 'EDIT_PRESENTATION_V1', canvas: DEFAULT_CANVAS_SETTINGS_V1, subtitleStyle: DEFAULT_SUBTITLE_STYLE_V1, output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' }, segmentation: { version: 'SCRIPT_SEGMENTATION_V1', mode: 'COMMA_SENTENCE' } };

export function canvasForAspectRatio(aspectRatio: PresentationAspectRatioV1, width = 1080): CanvasSettingsV1 {
  const safeWidth = Math.max(2, Math.round(width / 2) * 2);
  const height = aspectRatio === '9:16' ? Math.round(safeWidth * 16 / 9 / 2) * 2 : aspectRatio === '16:9' ? Math.round(safeWidth * 9 / 16 / 2) * 2 : safeWidth;
  return { ...DEFAULT_CANVAS_SETTINGS_V1, aspectRatio, width: safeWidth, height };
}

export function normalizePresentationSettings(value?: Partial<PresentationSettingsV1>): PresentationSettingsV1 {
  const canvas = { ...DEFAULT_CANVAS_SETTINGS_V1, ...(value?.canvas || {}) } as CanvasSettingsV1;
  const style = { ...DEFAULT_SUBTITLE_STYLE_V1, ...(value?.subtitleStyle || {}) } as SubtitleStyleV1;
  style.position = { ...DEFAULT_SUBTITLE_STYLE_V1.position, ...(value?.subtitleStyle?.position || {}) };
  style.outline = { ...DEFAULT_SUBTITLE_STYLE_V1.outline, ...(value?.subtitleStyle?.outline || {}) };
  style.shadow = { ...DEFAULT_SUBTITLE_STYLE_V1.shadow, ...(value?.subtitleStyle?.shadow || {}) };
  style.background = { ...DEFAULT_SUBTITLE_STYLE_V1.background, ...(value?.subtitleStyle?.background || {}) };
  style.position.x = Math.min(1, Math.max(0, Number(style.position.x)));
  style.position.y = Math.min(1, Math.max(0, Number(style.position.y)));
  return { schemaVersion: 'EDIT_PRESENTATION_V1', canvas, subtitleStyle: style, output: { ...DEFAULT_PRESENTATION_SETTINGS_V1.output, ...(value as { output?: Partial<OutputSettingsV1> } | undefined)?.output }, segmentation: { version: 'SCRIPT_SEGMENTATION_V1', mode: value?.segmentation?.mode || 'COMMA_SENTENCE', ...(value?.segmentation?.delimiters ? { delimiters: value.segmentation.delimiters } : {}) } };
}

export function validatePresentationSettings(value: PresentationSettingsV1): void {
  if (!['9:16', '16:9', '1:1'].includes(value.canvas.aspectRatio)) throw new Error('Presentation aspect ratio is invalid');
  if (!Number.isInteger(value.canvas.width) || !Number.isInteger(value.canvas.height) || value.canvas.width <= 0 || value.canvas.height <= 0 || value.canvas.width % 2 || value.canvas.height % 2) throw new Error('Presentation canvas dimensions must be positive even integers');
  const expectedRatio = value.canvas.aspectRatio === '9:16' ? 9 / 16 : value.canvas.aspectRatio === '16:9' ? 16 / 9 : 1;
  if (Math.abs(value.canvas.width / value.canvas.height - expectedRatio) > .03) throw new Error('Presentation canvas dimensions do not match aspect ratio');
  if (!Number.isInteger(value.canvas.fps) || value.canvas.fps < 1 || value.canvas.fps > 120) throw new Error('Presentation fps is invalid');
  if (!['FILL', 'CONTAIN', 'BLUR_BACKGROUND'].includes(value.canvas.fitMode)) throw new Error('Presentation fit mode is invalid');
  if (value.subtitleStyle.position.x < 0 || value.subtitleStyle.position.x > 1 || value.subtitleStyle.position.y < 0 || value.subtitleStyle.position.y > 1) throw new Error('Subtitle position must be normalized');
  if (!Number.isFinite(value.subtitleStyle.fontSize) || value.subtitleStyle.fontSize <= 0 || value.subtitleStyle.maxLines < 1 || value.subtitleStyle.maxLines > 3 || !Number.isFinite(value.subtitleStyle.animationDurationMs) || value.subtitleStyle.animationDurationMs < 0) throw new Error('Subtitle style is invalid');
  if (value.output.format !== 'mp4' || value.output.videoCodec !== 'h264' || value.output.audioCodec !== 'aac') throw new Error('Presentation output settings are invalid');
}
