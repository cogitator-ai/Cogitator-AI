/**
 * Text as social feeds count it: Bluesky in graphemes, Threads in
 * characters with emoji counted by their UTF-8 bytes. A plain `.length`
 * counts UTF-16 units, so it splits emoji and miscounts both.
 */

/** The length of a text as a feed counts it. */
export type TextMeasure = (text: string) => number;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const encoder = new TextEncoder();
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** The graphemes of `text`: what a reader sees as one character each. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (segment) => segment.segment);
}

/** The length in graphemes, as Bluesky counts it. */
export const graphemeLength: TextMeasure = (text) => graphemes(text).length;

/** The length with emoji counted by their UTF-8 bytes, as Threads counts it. */
export const threadsLength: TextMeasure = (text) => {
  let total = 0;
  for (const grapheme of graphemes(text)) {
    total += EMOJI.test(grapheme) ? encoder.encode(grapheme).length : 1;
  }
  return total;
};

/** How many of the first `parts` fit in `max` together. */
function fittingCount(parts: readonly string[], max: number, measure: TextMeasure): number {
  let low = 0;
  let high = parts.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(parts.slice(0, middle).join('')) <= max) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * `text` cut to `max` with `ellipsis` when it is longer: at the last word
 * boundary in the second half of what fits, else mid-word, never inside a
 * grapheme.
 */
export function fitText(
  text: string,
  max: number,
  measure: TextMeasure = graphemeLength,
  ellipsis = '…'
): string {
  if (measure(text) <= max) return text;
  const room = max - measure(ellipsis);
  if (room <= 0) {
    const marks = graphemes(ellipsis);
    return marks.slice(0, fittingCount(marks, max, measure)).join('');
  }
  const parts = graphemes(text);
  const count = fittingCount(parts, room, measure);
  let cut = count;
  for (let i = count; i > count / 2; i--) {
    if (/\s/u.test(parts[i] ?? '')) {
      cut = i;
      break;
    }
  }
  return (
    parts
      .slice(0, cut)
      .join('')
      .replace(/[\s,;:–—-]+$/u, '') + ellipsis
  );
}

/** Splits a line longer than `max` at word boundaries, words longer than `max` mid-word. */
function splitWords(line: string, max: number, measure: TextMeasure): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of line.split(/(?<=\s)/u)) {
    if (measure((current + word).trimEnd()) <= max) {
      current += word;
      continue;
    }
    if (current.trim()) out.push(current.trimEnd());
    let rest = graphemes(word);
    while (measure(rest.join('').trimEnd()) > max) {
      const count = Math.max(fittingCount(rest, max, measure), 1);
      out.push(rest.slice(0, count).join(''));
      rest = rest.slice(count);
    }
    current = rest.join('');
  }
  if (current.trim()) out.push(current.trimEnd());
  return out;
}

/**
 * `text` in parts of at most `max`, for a thread of posts or a run of
 * messages: whole paragraphs where they fit, else lines, else words, else
 * graphemes.
 */
export function splitText(
  text: string,
  max: number,
  measure: TextMeasure = graphemeLength
): string[] {
  if (max < 1) throw new RangeError(`max must be at least 1, got ${max}`);
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (measure(trimmed) <= max) return [trimmed];
  const out: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = '';
  };
  for (const block of trimmed.split(/\n{2,}/u)) {
    const pieces =
      measure(block) <= max
        ? [block]
        : block
            .split('\n')
            .flatMap((line) => (measure(line) <= max ? [line] : splitWords(line, max, measure)));
    for (const [index, piece] of pieces.entries()) {
      const separator = current ? (index > 0 ? '\n' : '\n\n') : '';
      if (current && measure(current + separator + piece) <= max) {
        current += separator + piece;
      } else {
        flush();
        current = piece;
      }
    }
  }
  flush();
  return out;
}
