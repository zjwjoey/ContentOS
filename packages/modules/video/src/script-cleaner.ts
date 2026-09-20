import type { ScriptSentence } from './sentence-segmenter.js';

export type ScriptCleaningModeV1 = 'COMMA_SENTENCE' | 'SENTENCE_ONLY' | 'CUSTOM';
export interface ScriptCleaningOptionsV1 { mode?: ScriptCleaningModeV1; delimiters?: string[] }
export interface CleanScriptResultV1 { rawScript: string; cleanedScript: string; segments: ScriptSentence[] }

const DEFAULT_COMMA = new Set(['，', ',', '。', '！', '!', '？', '?', '；', ';', '\n', '\r']);
const SENTENCE = new Set(['。', '！', '!', '？', '?', '\n', '\r']);
function protectedDelimiter(text: string, index: number): boolean {
  const c = text[index] || '';
  if (c === ',' || c === '，') {
    const prev = text[index - 1] || ''; const next = text[index + 1] || '';
    if (/\d/u.test(prev) && /\d/u.test(next)) return true;
  }
  if (c === '.') {
    const prev = text[index - 1] || ''; const next = text[index + 1] || '';
    if (/\d/u.test(prev) && /\d/u.test(next)) return true;
    const around = text.slice(Math.max(0, index - 16), Math.min(text.length, index + 24));
    if (/(?:https?:\/\/|www\.)[^\s]*$/iu.test(around.slice(0, around.indexOf(c) + 1))) return true;
    if (/[A-Za-z0-9_-]/u.test(prev) && /[A-Za-z0-9_-]/u.test(next) && /\.(?:com|cn|net|org|io|tv)\b/iu.test(text.slice(Math.max(0, index - 24), Math.min(text.length, index + 24)))) return true;
  }
  return false;
}

export function cleanScriptTextV1(rawScript: string): string {
  return rawScript.normalize('NFKC').replace(/\r\n?/gu, '\n').split('\n').map((line) => line.replace(/[ \t]+/gu, ' ').trim()).filter(Boolean).join('\n').replace(/\s*([，。！？；：,.!?;:])\s*/gu, '$1').trim();
}

export function cleanAndSegmentScriptV1(rawScript: string, options: ScriptCleaningOptionsV1 = {}): CleanScriptResultV1 {
  const cleanedScript = cleanScriptTextV1(rawScript || '');
  const mode = options.mode || 'COMMA_SENTENCE';
  const delimiters = new Set(mode === 'SENTENCE_ONLY' ? [...SENTENCE] : mode === 'CUSTOM' ? (options.delimiters || []).flatMap((value) => [...value]) : [...DEFAULT_COMMA]);
  const segments: ScriptSentence[] = []; let buffer = '';
  const push = (): void => { const text = buffer.replace(/\s+/gu, ' ').trim(); if (text) segments.push({ index: segments.length, text, normalizedText: text.normalize('NFKC').toLowerCase() }); buffer = ''; };
  for (let i = 0; i < cleanedScript.length; i += 1) {
    const char = cleanedScript[i]!; buffer += char;
    if ((char === '\n' || delimiters.has(char)) && !protectedDelimiter(cleanedScript, i)) {
      // Keep question/exclamation marks for natural subtitle punctuation; other delimiters are separators.
      if (!/[！？!?]/u.test(char)) buffer = buffer.slice(0, -1);
      push();
    }
  }
  push();
  return { rawScript, cleanedScript, segments };
}

export function mergeScriptSegmentsV1(segments: ScriptSentence[], index: number): ScriptSentence[] {
  if (index < 0 || index >= segments.length - 1) return segments;
  const merged = `${segments[index]!.text}${segments[index + 1]!.text}`.trim();
  return [...segments.slice(0, index), { index, text: merged, normalizedText: merged.normalize('NFKC').toLowerCase() }, ...segments.slice(index + 2)].map((item, i) => ({ ...item, index: i }));
}
export function splitScriptSegmentV1(segments: ScriptSentence[], index: number, at: number): ScriptSentence[] {
  const target = segments[index]; if (!target || at <= 0 || at >= target.text.length) return segments;
  const left = target.text.slice(0, at).trim(); const right = target.text.slice(at).trim(); if (!left || !right) return segments;
  return [...segments.slice(0, index), { index, text: left, normalizedText: left.normalize('NFKC').toLowerCase() }, { index: index + 1, text: right, normalizedText: right.normalize('NFKC').toLowerCase() }, ...segments.slice(index + 1)].map((item, i) => ({ ...item, index: i }));
}
export function removeEmptyScriptSegmentsV1(segments: ScriptSentence[]): ScriptSentence[] { return segments.filter((segment) => segment.text.trim()).map((segment, index) => ({ ...segment, index, text: segment.text.trim(), normalizedText: segment.text.normalize('NFKC').toLowerCase().trim() })); }
