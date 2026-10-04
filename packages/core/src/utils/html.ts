export interface HtmlTextToken {
  type: 'text';
  text: string;
  start: number;
  end: number;
}

export interface HtmlTagToken {
  type: 'tag';
  /** Lowercased tag name, empty for declarations such as `<!doctype html>` */
  name: string;
  closing: boolean;
  source: string;
  start: number;
  end: number;
}

export type HtmlToken = HtmlTextToken | HtmlTagToken;

const TAG_NAME = /^<(\/?)([a-z][a-z0-9-]*)/i;
const RAW_TEXT_ELEMENTS = ['script', 'style', 'textarea', 'title'] as const;
const RAW_TEXT_END = new Map<string, RegExp>(
  RAW_TEXT_ELEMENTS.map((name) => [name, new RegExp(`</${name}[\\s/>]`, 'gi')])
);
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;
const NOT_NAME_START = /[\s"'>/=]/;
const ENTITY = /&(?:nbsp|amp|lt|gt|quot|#39);/g;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r' || char === '\f';
}

function startsTag(char: string | undefined): boolean {
  return char !== undefined && /[a-zA-Z/!?]/.test(char);
}

/** Index of the `>` ending the tag whose body starts at `from`, skipping quoted attribute values; -1 at end of input */
function findTagEnd(html: string, from: number): number {
  let i = from;
  while (i < html.length) {
    const char = html[i];
    if (char === '>') return i;
    i++;
    if (char !== '=') continue;

    while (i < html.length && isWhitespace(html[i])) i++;
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, i + 1);
      if (close === -1) return -1;
      i = close + 1;
    }
  }
  return -1;
}

/**
 * Split HTML into text and tags in one linear pass, the way a browser reads them: a tag
 * starts at `<` followed by a letter, `/`, `!` or `?` and ends at the first `>` outside a
 * quoted attribute value, comments are dropped, and any other `<` is text. Every scan
 * resumes where the previous one stopped, so hostile markup (thousands of unclosed tags,
 * quotes or comments) cannot make it quadratic. Markup cut off inside a tag ends the
 * tokens there and the rest stays text. The content of `script`, `style`, `textarea` and
 * `title` is text up to its closing tag, and an element of those never closed runs to the
 * end of the input, which then closes it.
 */
export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let textStart = 0;
  let search = 0;
  let commentEnd = -1;

  const pushText = (end: number) => {
    if (end > textStart) {
      tokens.push({ type: 'text', text: html.slice(textStart, end), start: textStart, end });
    }
  };

  for (;;) {
    const open = html.indexOf('<', search);
    if (open === -1) break;

    if (html.startsWith('<!--', open)) {
      if (commentEnd < open + 4) {
        const found = html.indexOf('-->', open + 4);
        commentEnd = found === -1 ? html.length : found;
      }
      if (commentEnd < html.length) {
        pushText(open);
        textStart = search = commentEnd + 3;
        continue;
      }
    }

    if (!startsTag(html[open + 1])) {
      search = open + 1;
      continue;
    }

    const end = findTagEnd(html, open + 1);
    if (end === -1) break;

    pushText(open);
    const source = html.slice(open, end + 1);
    const match = TAG_NAME.exec(source);
    const name = match ? match[2].toLowerCase() : '';
    const closing = match?.[1] === '/';
    tokens.push({ type: 'tag', name, closing, source, start: open, end: end + 1 });
    textStart = search = end + 1;

    const rawTextEnd = closing ? undefined : RAW_TEXT_END.get(name);
    if (rawTextEnd) {
      rawTextEnd.lastIndex = search;
      const close = rawTextEnd.exec(html);
      if (!close) {
        pushText(html.length);
        tokens.push({
          type: 'tag',
          name,
          closing: true,
          source: '',
          start: html.length,
          end: html.length,
        });
        return tokens;
      }
      pushText(close.index);
      textStart = search = close.index;
    }
  }

  pushText(html.length);
  return tokens;
}

/** The value of attribute `name` on a tag, `undefined` when the tag does not carry it */
export function getAttribute(tag: HtmlTagToken, name: string): string | undefined {
  const source = tag.source;
  const nameEnd = source.search(/[\s/>]/);
  if (nameEnd === -1) return undefined;

  let index = nameEnd;
  while (index < source.length) {
    if (NOT_NAME_START.test(source[index])) {
      index++;
      continue;
    }
    ATTRIBUTE.lastIndex = index;
    const match = ATTRIBUTE.exec(source);
    if (!match) break;
    if (match[1].toLowerCase() === name) return match[2] ?? match[3] ?? match[4] ?? '';
    index = ATTRIBUTE.lastIndex;
  }
  return undefined;
}

/** Decode the entities HTML text commonly carries, each exactly once */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (entity) => ENTITIES[entity]);
}

/**
 * Index of the tag closing the element opened at `open`, counting nested elements of
 * the same name, or -1 when the element is never closed.
 */
export function findClosingTag(tokens: readonly HtmlToken[], open: number): number {
  const opening = tokens[open];
  if (opening.type !== 'tag') return -1;

  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'tag' || token.name !== opening.name) continue;
    depth += token.closing ? -1 : 1;
    if (depth === 0) return i;
  }
  return -1;
}

/**
 * Drop every element named in `names`, from its opening tag to the first closing tag of
 * the same name, leaving a space so the text on both sides stays apart. An element that is
 * never closed only loses its opening tag.
 */
export function removeElements(
  tokens: readonly HtmlToken[],
  names: ReadonlySet<string>
): HtmlToken[] {
  const closers = new Map<string, number[]>();
  tokens.forEach((token, index) => {
    if (token.type === 'tag' && token.closing && names.has(token.name)) {
      const list = closers.get(token.name);
      if (list) list.push(index);
      else closers.set(token.name, [index]);
    }
  });

  const cursors = new Map<string, number>();
  const result: HtmlToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'tag' && !token.closing && names.has(token.name)) {
      const list = closers.get(token.name) ?? [];
      let cursor = cursors.get(token.name) ?? 0;
      while (cursor < list.length && list[cursor] < i) cursor++;
      cursors.set(token.name, cursor);
      if (cursor < list.length) {
        const close = tokens[list[cursor]];
        result.push({ type: 'text', text: ' ', start: token.start, end: close.end });
        i = list[cursor];
        continue;
      }
    }
    result.push(token);
  }
  return result;
}
