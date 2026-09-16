export interface ScriptSentence {
  index: number;
  text: string;
  normalizedText: string;
}

export interface SegmentScriptOptions {
  /** Semicolons are opt-in because many scripts use them as inline punctuation. */
  splitSemicolon?: boolean;
}

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'etc', 'e.g', 'i.e', 'vs', 'no']);

function isDigit(value: string | undefined): boolean { return value !== undefined && /\d/.test(value); }
function isAsciiLetter(value: string | undefined): boolean { return value !== undefined && /[A-Za-z]/.test(value); }
function isUrlAt(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 12), index + 1);
  return /(?:https?:\/\/|www\.)[^\s]*$/i.test(prefix) || (index > 0 && /[A-Za-z0-9-]/.test(text[index - 1] || '') && /[A-Za-z0-9-]/.test(text[index + 1] || '') && /\b(?:com|cn|net|org|io|co|tv)\b/i.test(text.slice(index - 24, index + 24)));
}

function periodIsBoundary(text: string, index: number, buffer: string): boolean {
  const previous = text[index - 1]; const next = text[index + 1];
  if (isDigit(previous) && isDigit(next)) return false;
  if (isUrlAt(text, index)) return false;
  const before = `${buffer}${text[index]}`;
  const token = buffer.trim().split(/\s+/u).at(-1)?.replace(/["'“”‘’([{]+/gu, '').toLowerCase() || '';
  if (ABBREVIATIONS.has(token)) return false;
  // Protect multi-period abbreviations (e.g., i.e., U.S.) and initials.
  if (/(?:^|\s)(?:e|i)\.$/iu.test(before) && /^\s*[A-Za-z]\./u.test(text.slice(index + 1))) return false;
  if (/(?:\b[A-Za-z]\.){2,}$/u.test(before)) return false;
  if (/\b[A-Za-z]\.$/u.test(before) && /^\s+[A-Z]/u.test(text.slice(index + 1))) return false;
  if (isAsciiLetter(previous) && isAsciiLetter(next) && next !== undefined && next === next.toUpperCase()) return false;
  return true;
}

function pushSentence(result: ScriptSentence[], buffer: string): void {
  const text = buffer.replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!text) return;
  result.push({ index: result.length, text, normalizedText: text.normalize('NFKC').toLowerCase() });
}

/**
 * Split a mixed Chinese/English script into stable, non-empty sentences.
 * Decimal numbers, URLs and common abbreviations are protected from period splitting.
 */
export function segmentScriptSentences(script: string, options: SegmentScriptOptions = {}): ScriptSentence[] {
  if (typeof script !== 'string' || !script.trim()) return [];
  const result: ScriptSentence[] = []; let buffer = '';
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]!;
    if (character === '\r' || character === '\n') {
      pushSentence(result, buffer); buffer = '';
      while (script[index + 1] === '\r' || script[index + 1] === '\n') index += 1;
      continue;
    }
    const delimiter = character === '。' || character === '？' || character === '?' || character === '！' || character === '!' || (options.splitSemicolon === true && (character === '；' || character === ';')) || (character === '.' && periodIsBoundary(script, index, buffer));
    buffer += character;
    if (delimiter) { pushSentence(result, buffer); buffer = ''; }
  }
  pushSentence(result, buffer);
  return result;
}

export const splitScriptSentences = segmentScriptSentences;
