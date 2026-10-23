const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** The marker of a line that opens a fenced block: a backtick fence's info string has no backtick. */
function openingFence(line: string): string | undefined {
  const marker = FENCE.exec(line)?.[1];
  if (!marker) return undefined;
  if (marker.startsWith('`') && line.includes('`', line.indexOf(marker) + marker.length)) {
    return undefined;
  }
  return marker;
}

/**
 * The code spans of a paragraph, as CommonMark reads them: a backtick run that no backslash
 * escapes opens one, the next run of the same length closes it, and a run nothing closes is
 * text. Backslashes inside a span are text. Each list of runs of one length is walked once, so
 * this is linear in the length of `text`.
 */
function codeSpansOf(text: string): Array<[number, number]> {
  const runsByLength = new Map<number, number[]>();
  for (let i = 0; i < text.length;) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && text[i] === '`') i++;
    const starts = runsByLength.get(i - start) ?? [];
    starts.push(start);
    runsByLength.set(i - start, starts);
  }
  const cursors = new Map<number, number>();
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (char !== '`') {
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && text[i] === '`') i++;
    const length = i - start;
    const starts = runsByLength.get(length) ?? [];
    let cursor = cursors.get(length) ?? 0;
    while (cursor < starts.length && starts[cursor] < i) cursor++;
    cursors.set(length, cursor);
    const closing = starts[cursor];
    if (closing === undefined) continue;
    spans.push([start, closing + length]);
    i = closing + length;
  }
  return spans;
}

/** `prose` with its images as links (`![` becomes `[`) and raw `<img` tags as text. */
function rewriteProse(prose: string): string {
  let out = '';
  for (let i = 0; i < prose.length; i++) {
    const char = prose[i];
    if (char === '\\' && i + 1 < prose.length) {
      out += char + prose[i + 1];
      i++;
    } else if (char === '!' && prose[i + 1] === '[') {
      continue;
    } else if (char === '<' && prose.slice(i + 1, i + 4).toLowerCase() === 'img') {
      out += '&lt;';
    } else {
      out += char;
    }
  }
  return out;
}

function rewriteParagraph(paragraph: string): string {
  let out = '';
  let from = 0;
  for (const [start, end] of codeSpansOf(paragraph)) {
    out += rewriteProse(paragraph.slice(from, start)) + paragraph.slice(start, end);
    from = end;
  }
  return out + rewriteProse(paragraph.slice(from));
}

/**
 * Markdown with its images turned into links and raw `<img>` tags into text, outside code
 * (fenced blocks and code spans, read as CommonMark reads them), so a client that loads images
 * as it shows a message cannot be made to request a URL the text names. Linear in the length of
 * `text`.
 */
export function imagesAsLinks(text: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    if (paragraph.length > 0) out.push(rewriteParagraph(paragraph.join('\n')));
    paragraph = [];
  };
  for (const line of text.split('\n')) {
    if (fence) {
      out.push(line);
      const closing = CLOSING_FENCE.exec(line)?.[1];
      if (closing?.[0] === fence[0] && closing.length >= fence.length) fence = undefined;
      continue;
    }
    const marker = openingFence(line);
    if (marker) {
      flush();
      fence = marker;
      out.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      out.push(line);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out.join('\n');
}
