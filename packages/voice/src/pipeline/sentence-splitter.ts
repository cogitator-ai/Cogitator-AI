export interface SentenceSplitterOptions {
  /**
   * Longest piece returned at once, in characters (default 250). A sentence without a break
   * before it is cut at the last whitespace, or at the limit when there is none.
   */
  maxLength?: number;
}

export const DEFAULT_MAX_SENTENCE_LENGTH = 250;

/** The shortest `maxLength`: a shorter piece would cut most words apart */
export const MIN_SENTENCE_LENGTH = 20;

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
  '*',
  '_',
  '`',
]);
const OPENERS = /^["'([{«“‘「『（【〈《*_`]+/;

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

/** The word that ends at `end`: what stands between the whitespace before it and `end` */
function wordBefore(text: string, end: number): { word: string; start: number } {
  let start = end;
  while (start > 0 && !isWhitespace(text[start - 1])) start--;
  return { word: text.slice(start, end).replace(OPENERS, ''), start };
}

/** The word before the one that starts at `start`, on the same line, if any */
function previousWord(text: string, start: number): string | undefined {
  let end = start;
  while (end > 0 && isWhitespace(text[end - 1])) {
    if (text[end - 1] === '\n') return undefined;
    end--;
  }
  if (end === 0) return undefined;
  return wordBefore(text, end).word;
}

/**
 * Whether the word before a period is abbreviated: a known abbreviation, dotted letters
 * (`e.g`, `U.S`), or a capital letter read as an initial, at the start of a sentence or after a
 * capitalized word (`J. R. R. Tolkien`, but not `vitamin C.`)
 */
function isAbbreviation(word: string, before: string | undefined): boolean {
  if (word.length === 0) return false;
  if (ABBREVIATIONS.has(word.toLowerCase())) return true;
  if (/^(\p{L}\.)+\p{L}$/u.test(word)) return true;
  if (!/^\p{Lu}$/u.test(word)) return false;
  return before === undefined || /^\p{Lu}/u.test(before);
}

/** The length of the code point at `at`: 2 for a surrogate pair, else 1 */
function codePointLength(text: string, at: number): number {
  const code = text.charCodeAt(at);
  return code >= 0xd800 && code <= 0xdbff && at + 1 < text.length ? 2 : 1;
}

/** `maxLength` checked, or the default when it is not set */
export function maxSentenceLength(maxLength: number | undefined): number {
  const length = maxLength ?? DEFAULT_MAX_SENTENCE_LENGTH;
  if (!Number.isInteger(length) || length < MIN_SENTENCE_LENGTH) {
    throw new RangeError(
      `maxSentenceLength must be an integer of at least ${MIN_SENTENCE_LENGTH}, got ${String(maxLength)}`
    );
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
 * list items are spoken one by one. Markdown emphasis and code marks after the stop (`**Note.**`)
 * stay with it. A period does not end a sentence after an abbreviation (`Dr.`, `e.g.`, `U.S.`,
 * an initial such as `J.`), inside a number (`3.14`), after a list number at the start of a line
 * (`1.`) or after the next number of a list that goes on in the same line (`1. Open it. 2. Close
 * it.`), or before a lowercase word. A piece longer than `maxLength` (at least 20) is cut at the
 * last whitespace before it, or at the limit when there is none.
 */
export class SentenceSplitter {
  private buffer = '';
  /** Whether the buffer starts a line: at the start of the text or after a line break */
  private lineStart = true;
  /** The number of the last list item taken (`2.` for "2. Close it."), to know the next one */
  private listNumber: number | undefined;
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
        const fits = this.buffer.slice(0, boundary.at).trimEnd().length <= this.maxLength;
        sentences.push(this.take(fits ? boundary.at : this.lengthCut()));
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
    this.lineStart = /\n\s*$/.test(sentence);
    const marker = /^\s*(\d+)\.\s/.exec(sentence);
    if (marker) this.listNumber = Number(marker[1]);
    return sentence;
  }

  /** Where a piece too long for `maxLength` is cut: always after at least one code point */
  private lengthCut(): number {
    const text = this.buffer;
    for (let at = this.maxLength; at > 0; at--) {
      if (isWhitespace(text[at])) {
        if (text.slice(0, at).trim().length > 0) return skipWhitespace(text, at);
        break;
      }
    }
    let cut = 0;
    while (cut < text.length) {
      const next = cut + codePointLength(text, cut);
      if (next > this.maxLength && cut > 0) break;
      cut = next;
    }
    return cut;
  }

  /**
   * Whether `word` opens a sentence as an item of a list whose items share a line: `1.`, or the
   * number after the last item taken ("Here are the steps. 1. Open it. 2. Close it.")
   */
  private continuesList(word: string, start: number): boolean {
    if (this.buffer.slice(0, start).trim().length > 0) return false;
    const number = Number(word);
    return number === 1 || (this.listNumber !== undefined && number === this.listNumber + 1);
  }

  /** Whether the text before `start` on its line is only whitespace */
  private opensLine(start: number): boolean {
    const text = this.buffer;
    const lineBegin = text.lastIndexOf('\n', start - 1) + 1;
    if (lineBegin === 0 && !this.lineStart) return false;
    return text.slice(lineBegin, start).trim().length === 0;
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
      if (isAbbreviation(word, previousWord(text, start))) return { kind: 'none' };
      if (/^\d+$/.test(word) && (this.opensLine(start) || this.continuesList(word, start))) {
        return { kind: 'none' };
      }
    }

    if (next === text.length) return final ? { kind: 'cut', at: next } : { kind: 'wait' };
    if (isLowercase(text[next])) return { kind: 'none' };
    return { kind: 'cut', at: next };
  }
}
