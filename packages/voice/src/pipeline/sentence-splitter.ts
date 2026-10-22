export interface SentenceSplitterOptions {
  /**
   * Longest piece returned at once, in characters (default 250). A sentence without a break
   * before it is cut at the last whitespace, or at the limit when there is none.
   */
  maxLength?: number;
}

export const DEFAULT_MAX_SENTENCE_LENGTH = 250;

const TERMINATORS = new Set(['.', '!', '?', '…']);
const CJK_TERMINATORS = new Set(['。', '！', '？', '｡']);
const CLOSERS = new Set([
  '"',
  "'",
  ')',
  ']',
  '}',
  '»',
  '”',
  '’',
  '」',
  '』',
  '）',
  '】',
  '〉',
  '》',
]);
const OPENERS = /^["'([{«“‘「『（【〈《]+/;

const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'mx',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'mt',
  'ft',
  'vs',
  'cf',
  'approx',
  'fig',
  'figs',
  'inc',
  'ltd',
  'corp',
  'dept',
  'gen',
  'col',
  'lt',
  'capt',
  'sgt',
  'rev',
  'hon',
  'gov',
  'sen',
  'rep',
  'ave',
  'blvd',
  'rd',
  'vol',
  'pp',
]);

type Boundary = { kind: 'cut'; at: number } | { kind: 'wait' } | { kind: 'none' };

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/u.test(char);
}

function isLowercase(char: string | undefined): boolean {
  return char !== undefined && /\p{Ll}/u.test(char);
}

function skipWhitespace(text: string, from: number): number {
  let at = from;
  while (at < text.length && isWhitespace(text[at])) at++;
  return at;
}

/** The word a period ends: what stands between the whitespace before it and the period */
function wordBefore(text: string, period: number): { word: string; start: number } {
  let start = period;
  while (start > 0 && !isWhitespace(text[start - 1])) start--;
  return { word: text.slice(start, period).replace(OPENERS, ''), start };
}

function isAbbreviation(word: string): boolean {
  if (word.length === 0) return false;
  if (ABBREVIATIONS.has(word.toLowerCase())) return true;
  if (/^\p{L}$/u.test(word)) return true;
  return /^(\p{L}\.)+\p{L}$/u.test(word);
}

/** `maxLength` checked, or the default when it is not set */
export function maxSentenceLength(maxLength: number | undefined): number {
  const length = maxLength ?? DEFAULT_MAX_SENTENCE_LENGTH;
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError(`maxSentenceLength must be a positive integer, got ${String(maxLength)}`);
  }
  return length;
}

/**
 * Splits text that arrives in pieces, such as a model's streamed answer, into sentences to
 * speak one at a time. Each piece it returns is a slice of the input, whitespace after it
 * included, so the pieces joined give the input back.
 *
 * A sentence ends at `.`, `!`, `?`, `…` or a run of them (`?!`, `...`) followed by whitespace,
 * after any closing quotes or brackets, at a CJK full stop (`。！？`) and at a line break, so
 * list items are spoken one by one. A period does not end a sentence after an abbreviation
 * (`Dr.`, `e.g.`, `U.S.`, an initial), inside a number (`3.14`), after a list number at the start
 * of a line (`1.`), or before a lowercase word. Text without a break is cut at `maxLength`.
 */
export class SentenceSplitter {
  private buffer = '';
  private readonly maxLength: number;

  constructor(options: SentenceSplitterOptions = {}) {
    this.maxLength = maxSentenceLength(options.maxLength);
  }

  /** Adds the next piece of text and returns the sentences it completed */
  push(text: string): string[] {
    this.buffer += text;
    return this.drain(false);
  }

  /** Returns what is left, the end of the text, as the last sentence */
  flush(): string[] {
    const sentences = this.drain(true);
    if (this.buffer.length > 0) sentences.push(this.buffer);
    this.buffer = '';
    return sentences;
  }

  private drain(final: boolean): string[] {
    const sentences: string[] = [];
    for (;;) {
      const boundary = this.findBoundary(final);
      if (boundary.kind === 'cut') {
        sentences.push(this.take(boundary.at));
        continue;
      }
      if (this.buffer.length > this.maxLength) {
        sentences.push(this.take(this.lengthCut()));
        continue;
      }
      return sentences;
    }
  }

  private take(at: number): string {
    const sentence = this.buffer.slice(0, at);
    this.buffer = this.buffer.slice(at);
    return sentence;
  }

  private lengthCut(): number {
    const text = this.buffer;
    for (let at = this.maxLength; at > 0; at--) {
      if (isWhitespace(text[at])) {
        if (text.slice(0, at).trim().length > 0) return skipWhitespace(text, at);
        break;
      }
    }
    const code = text.charCodeAt(this.maxLength - 1);
    const splitsPair = code >= 0xd800 && code <= 0xdbff;
    return splitsPair ? this.maxLength - 1 : this.maxLength;
  }

  private findBoundary(final: boolean): Boundary {
    const text = this.buffer;
    for (let at = 0; at < text.length; at++) {
      const char = text[at]!;
      const boundary =
        char === '\n'
          ? this.lineBreak(at)
          : CJK_TERMINATORS.has(char)
            ? this.cjkStop(at)
            : TERMINATORS.has(char)
              ? this.terminator(at, final)
              : undefined;
      if (!boundary) continue;
      if (boundary.kind === 'cut' && text.slice(0, boundary.at).trim().length === 0) continue;
      if (boundary.kind !== 'none') return boundary;
    }
    return { kind: 'none' };
  }

  private lineBreak(at: number): Boundary {
    return { kind: 'cut', at: skipWhitespace(this.buffer, at) };
  }

  private cjkStop(at: number): Boundary {
    const text = this.buffer;
    let end = at + 1;
    while (end < text.length && (CJK_TERMINATORS.has(text[end]!) || CLOSERS.has(text[end]!))) {
      end++;
    }
    return { kind: 'cut', at: skipWhitespace(text, end) };
  }

  private terminator(at: number, final: boolean): Boundary {
    const text = this.buffer;
    let runEnd = at;
    while (runEnd < text.length && TERMINATORS.has(text[runEnd]!)) runEnd++;
    let end = runEnd;
    while (end < text.length && CLOSERS.has(text[end]!)) end++;

    if (end === text.length) return final ? { kind: 'cut', at: end } : { kind: 'wait' };
    if (!isWhitespace(text[end])) return { kind: 'none' };

    const next = skipWhitespace(text, end);
    const run = text.slice(at, runEnd);
    if (/[!?]/.test(run) || text.slice(end, next).includes('\n')) return { kind: 'cut', at: next };

    if (run === '.') {
      const { word, start } = wordBefore(text, at);
      if (isAbbreviation(word)) return { kind: 'none' };
      const opensLine = text.slice(0, start).trim().length === 0 || text[start - 1] === '\n';
      if (/^\d+$/.test(word) && opensLine) return { kind: 'none' };
    }

    if (next === text.length) return final ? { kind: 'cut', at: next } : { kind: 'wait' };
    if (isLowercase(text[next])) return { kind: 'none' };
    return { kind: 'cut', at: next };
  }
}
