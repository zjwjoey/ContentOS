import type { EditManifestV0, SubtitleTimeline } from '../../../contracts/src/index.js';

export function subtitleTimelineToManifestCues(timeline: SubtitleTimeline, style: NonNullable<EditManifestV0['subtitles']>[number]['style'] = 'simple'): NonNullable<EditManifestV0['subtitles']> {
  return timeline.cues.map((cue) => ({ text: cue.text, startMs: cue.startMs, endMs: cue.endMs, style, position: 'bottom' }));
}

function timestamp(ms: number, separator: ',' | '.'): string {
  const safe = Math.max(0, Math.round(ms)); const hours = Math.floor(safe / 3_600_000); const minutes = Math.floor((safe % 3_600_000) / 60_000); const seconds = Math.floor((safe % 60_000) / 1_000); const millis = safe % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
}

function assText(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('{', '\\{').replaceAll('}', '\\}').replaceAll('\n', '\\N'); }

export function subtitleTimelineToSrt(timeline: SubtitleTimeline): string {
  return timeline.cues.map((cue) => `${cue.index}\n${timestamp(cue.startMs, ',')} --> ${timestamp(cue.endMs, ',')}\n${cue.text}\n`).join('\n');
}

export function subtitleTimelineToAss(timeline: SubtitleTimeline): string {
  const header = '[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,100,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  return header + timeline.cues.map((cue) => `Dialogue: 0,${timestamp(cue.startMs, '.') .slice(0, -1)},${timestamp(cue.endMs, '.') .slice(0, -1)},Default,,0,0,0,,${assText(cue.text)}`).join('\n') + (timeline.cues.length ? '\n' : '');
}
